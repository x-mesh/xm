#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { readSyncConfig } from './sync-config.mjs';
import { HANDOFF_STATE_PATH, HANDOFF_MARKDOWN_PATH, isCanonicalHandoffPath, isExcludedHandoffPath, reconcileHandoff } from './sync-handoff.mjs';
import { canonicalLessonPath, mergeLessonVersions, migrateLessonStore } from './sync-lessons.mjs';
import { contentHash, fileHash, isSyncablePath, readSyncState, safePath, saveSyncState, scopeFor, withSyncLock, writeAtomic } from './sync-storage.mjs';

function namespacePath(path, machineId) {
  const ext = extname(path);
  return ext ? `${path.slice(0, -ext.length)}.${machineId}${ext}` : `${path}.${machineId}`;
}

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

function validMachine(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 255 && !id.includes('/') && !id.includes('\\') && !id.includes('\0') && id !== '.' && id !== '..';
}

function trackedHash(record, hash) {
  return hash !== null && (hash === record.hash || (record.pending && hash === record.previous_hash));
}

function chooseTarget(xmDir, path, machineId, record, shared) {
  if (record) {
    const target = safePath(xmDir, record.target);
    if (!existsSync(target) || trackedHash(record, fileHash(target))) return record.target;
    console.log(`[x-sync pull] preserved local edit at ${record.target}`);
  }
  if (!shared && !existsSync(safePath(xmDir, path))) return path;
  const ns = namespacePath(path, machineId);
  if (!existsSync(safePath(xmDir, ns))) return ns;
  for (let index = 1; index <= 100; index++) {
    const candidate = namespacePath(path, `${machineId}.conflict-${index}`);
    if (!existsSync(safePath(xmDir, candidate))) return candidate;
  }
  throw new Error(`cannot allocate a remote copy without overwriting local files: ${path}`);
}

async function main() {
  const config = readSyncConfig();
  if (!config.server_url || !config.api_key) throw new Error('x-sync not configured. Run: x-sync setup');
  const xmDir = resolveXmDir();
  const projectId = process.argv.includes('--project') ? process.argv[process.argv.indexOf('--project') + 1] : basename(resolve(xmDir, '..'));
  await withSyncLock(xmDir, async () => {
    const state = readSyncState(xmDir);
    const scope = scopeFor(state, config, projectId);
    const params = new URLSearchParams({ project_id: projectId });
    if (process.argv.includes('--since')) {
      const since = Number(process.argv[process.argv.indexOf('--since') + 1]);
      if (!Number.isSafeInteger(since) || since < 0) throw new Error('invalid --since timestamp');
      params.set('since', String(since));
    } else params.set('cursor', String(scope.cursor));
    console.log(`[x-sync pull] project=${projectId} ${params.toString()}`);
    const response = await fetch(`${config.server_url.replace(/\/+$/, '')}/sync/pull?${params}`, { headers: { 'X-Api-Key': config.api_key }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Server error ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.files) || (data.cursor != null && (!Number.isSafeInteger(data.cursor) || data.cursor < 0))) throw new Error('invalid sync response');
    const files = data.files;
    const byPath = new Map(), tombstones = [], handoffFiles = [];
    for (const file of files) {
      if (!file || typeof file.path !== 'string' || !validMachine(file.machine_id) || (!file.deleted && typeof file.content !== 'string')) throw new Error('invalid remote file');
      if (file.machine_id === config.machine_id || !isSyncablePath(file.path) || isExcludedHandoffPath(file.path)) continue;
      const path = relative(resolve(xmDir), safePath(xmDir, file.path)).split('\\').join('/');
      const item = { ...file, path };
      if (isCanonicalHandoffPath(path)) { handoffFiles.push(item); continue; }
      if (canonicalLessonPath(path)) {
        if (!file.deleted) {
          const canonical = canonicalLessonPath(path);
          if (!byPath.has(canonical)) byPath.set(canonical, []);
          byPath.get(canonical).push(item);
        }
        continue;
      }
      if (file.deleted) { tombstones.push(item); continue; }
      if (!byPath.has(path)) byPath.set(path, []);
      byPath.get(path).push(item);
    }

    const lessonDir = safePath(xmDir, 'humble/lessons');
    if (existsSync(lessonDir)) for (const name of readdirSync(lessonDir)) {
      if (canonicalLessonPath(`humble/lessons/${name}`)) safePath(xmDir, `humble/lessons/${name}`);
    }
    const migration = migrateLessonStore(xmDir);
    if (handoffFiles.length) { safePath(xmDir, HANDOFF_STATE_PATH); safePath(xmDir, HANDOFF_MARKDOWN_PATH); }
    const handoff = reconcileHandoff(xmDir, handoffFiles);
    let written = 0, removed = 0, namespaced = 0, invalidLessons = migration.invalid;
    for (const file of tombstones) {
      const key = JSON.stringify([file.machine_id, file.path]);
      const record = scope.imports[key];
      if (!record) continue;
      const target = safePath(xmDir, record.target);
      if (existsSync(target)) {
        if (trackedHash(record, fileHash(target))) { rmSync(target); removed++; }
        else {
          console.log(`[x-sync pull] preserved local edit after remote deletion: ${record.target}`);
          if (record.target !== record.path) {
            scope.retired_imports ||= {};
            scope.retired_imports[record.target] = { ...record, pending: false };
          }
        }
      }
      delete scope.imports[key]; saveSyncState(xmDir, state);
    }
    for (const [path, versions] of byPath) {
      if (canonicalLessonPath(path)) {
        safePath(xmDir, path);
        const result = mergeLessonVersions(xmDir, path, versions);
        if (result.written) written++;
        invalidLessons += result.invalid;
        continue;
      }
      for (const file of versions) {
        const key = JSON.stringify([file.machine_id, path]);
        const previous = scope.imports[key];
        const target = chooseTarget(xmDir, path, file.machine_id, previous, versions.length > 1);
        if (previous && previous.target !== path && previous.target !== target) {
          // Edited remote namespace copies must not reappear as locally authored paths on push.
          scope.retired_imports ||= {};
          scope.retired_imports[previous.target] = { ...previous, pending: false };
        }
        const hash = contentHash(file.content);
        const existingHash = fileHash(safePath(xmDir, target));
        const record = { machine_id: file.machine_id, path, target, hash, pending: true, previous_hash: existingHash };
        // Journal ownership first so a crash cannot turn a downloaded file into a local push candidate.
        scope.imports[key] = record; saveSyncState(xmDir, state);
        if (existingHash !== hash) { writeAtomic(xmDir, target, file.content); written++; }
        record.pending = false; delete record.previous_hash; saveSyncState(xmDir, state);
        if (target !== path) namespaced++;
      }
    }
    scope.cursor = data.cursor ?? scope.cursor;
    state.last_pull = data.server_time;
    state.last_pull_at = Date.now(); state.last_pull_project = projectId;
    state.last_pull_files = files.length; state.last_pull_cursor = scope.cursor;
    saveSyncState(xmDir, state);
    if (handoff.invalid) console.error(`[x-sync pull] ${handoff.invalid} invalid handoff(s) ignored; local state preserved`);
    if (invalidLessons) console.error(`[x-sync pull] ${invalidLessons} invalid lesson file(s) ignored`);
    const handoffMessage = handoff.status === 'updated' ? `handoff updated from ${handoff.machine_id}` : `handoff ${handoff.status}`;
    console.log(`[x-sync pull] ${written} files written, ${namespaced} namespaced, ${removed} removed; ${migration.removed} lesson duplicates removed; ${handoffMessage}`);
  });
}

main().catch(error => { console.error(`[x-sync pull] Failed: ${error.message}`); process.exitCode = 1; });
