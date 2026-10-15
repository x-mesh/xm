import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function contentHash(content) { return createHash('sha256').update(content).digest('hex'); }

export function safePath(base, path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || isAbsolute(path)) throw new Error(`unsafe sync path: ${path}`);
  const root = resolve(base), target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`unsafe sync path: ${path}`);
  let cursor = root;
  for (const part of ['', ...rel.split(sep)]) {
    if (part) cursor = join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error(`sync path contains a symlink: ${cursor}`); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') break; throw error; }
  }
  return target;
}

export function fileHash(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink()) throw new Error(`sync file is a symlink: ${path}`);
  if (!stat.isFile()) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return contentHash(readFileSync(fd)); } finally { closeSync(fd); }
}

export function writeAtomic(base, path, content) {
  const target = safePath(base, path);
  mkdirSync(dirname(target), { recursive: true });
  safePath(base, path);
  const temp = join(dirname(target), `.${basename(target)}.sync-tmp-${randomUUID()}`);
  let previousMode = null;
  try { const stat = lstatSync(target); if (stat.isFile()) previousMode = stat.mode & 0o777; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
  try {
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
    // Atomic replacement must not broaden an existing file's permissions.
    if (previousMode !== null) chmodSync(temp, previousMode);
    safePath(base, path); renameSync(temp, target);
  } finally { rmSync(temp, { force: true }); }
}

export function isSyncablePath(path) {
  const parts = path.split('/');
  if (['merge-review', 'worktrees'].includes(parts[0])) return false;
  if (parts.some(part => ['run', 'node_modules', 'repro', 'verification-work', 'lifecycle.lock'].includes(part))) return false;
  if (parts.some(part => (part.startsWith('.') && part !== '.active') || part.endsWith('.tmp') || part.endsWith('.bak') || part === 'config.json')) return false;
  return true;
}

export function readSyncState(xmDir) {
  const path = safePath(xmDir, '.sync-state.json');
  if (!existsSync(path)) return {};
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid sync state');
  if (state.pull_scopes !== undefined && (!state.pull_scopes || typeof state.pull_scopes !== 'object' || Array.isArray(state.pull_scopes))) throw new Error('invalid sync scopes');
  importedFiles(state);
  return state;
}

export function saveSyncState(xmDir, state) { writeAtomic(xmDir, '.sync-state.json', `${JSON.stringify(state)}\n`); }

export function scopeFor(state, config, projectId) {
  const key = JSON.stringify([config.server_url.replace(/\/+$/, ''), projectId, config.machine_id]);
  state.pull_scopes ||= {};
  if (!Object.hasOwn(state.pull_scopes, key)) state.pull_scopes[key] = { cursor: 0, imports: {} };
  const scope = state.pull_scopes[key];
  if (!Number.isSafeInteger(scope.cursor) || scope.cursor < 0 || !scope.imports || typeof scope.imports !== 'object' || Array.isArray(scope.imports)) throw new Error('invalid sync cursor or import registry');
  return scope;
}

export function importedFiles(state) {
  return Object.values(state.pull_scopes || {}).flatMap(scope => {
    if (!scope?.imports || typeof scope.imports !== 'object' || Array.isArray(scope.imports)) throw new Error('invalid sync import registry');
    if (scope.retired_imports !== undefined && (!scope.retired_imports || typeof scope.retired_imports !== 'object' || Array.isArray(scope.retired_imports))) throw new Error('invalid retired sync imports');
    const records = [...Object.values(scope.imports), ...Object.values(scope.retired_imports || {})];
    if (records.some(record => !record || typeof record.target !== 'string' || typeof record.path !== 'string'
      || typeof record.machine_id !== 'string' || !/^[0-9a-f]{64}$/.test(record.hash || '')
      || (record.pending !== undefined && typeof record.pending !== 'boolean')
      || (record.previous_hash != null && !/^[0-9a-f]{64}$/.test(record.previous_hash)))) throw new Error('invalid sync import provenance');
    return records;
  });
}

export async function withSyncLock(xmDir, action) {
  mkdirSync(xmDir, { recursive: true });
  const lock = safePath(xmDir, '.sync-lock');
  try { mkdirSync(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(readFileSync(safePath(lock, 'owner.json'), 'utf8')); }
    catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
      if (Date.now() - lstatSync(lock).mtimeMs < 5000) throw new Error('sync lock owner is being created');
    }
    if (owner !== undefined && (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0)) throw new Error('invalid sync lock owner');
    let alive = false;
    if (owner) try { process.kill(owner.pid, 0); alive = true; } catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    if (alive) throw new Error('sync is already running in this workspace');
    // A crashed sync process must not permanently block its next invocation.
    rmSync(lock, { recursive: true }); mkdirSync(lock);
  }
  try { writeAtomic(lock, 'owner.json', JSON.stringify({ pid: process.pid })); return await action(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}
