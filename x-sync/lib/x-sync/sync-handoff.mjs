/**
 * Cross-machine handoff reconciliation for x-sync.
 *
 * Most .xm files use machine-namespaced merge semantics. A handoff is
 * different: handon reads one canonical SESSION-STATE.json, so remote copies
 * must be reduced to the newest valid saved_at and promoted atomically.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const HANDOFF_STATE_PATH = 'build/SESSION-STATE.json';
export const HANDOFF_MARKDOWN_PATH = 'build/HANDOFF.md';
export const MEMMESH_MIRROR_PATH = 'build/memmesh-mirror.json';
const HANDOFF_POINTER = '# Session Handoff\n\n> The canonical, atomic session state is `.xm/build/SESSION-STATE.json`.\n> Read that JSON file directly. This Markdown file is intentionally a stable pointer,\n> not a second snapshot, so an interrupted save cannot expose mixed generations.\n';

const LEGACY_STATE_RE = /^build\/SESSION-STATE\.[^/]+\.json$/;
const LEGACY_MARKDOWN_RE = /^build\/HANDOFF\.[^/]+\.md$/;
const HANDOFF_BACKUP_RE = /^build\/SESSION-STATE\.pre-sync-[^/]+\.json$/;

export function isCanonicalHandoffPath(path) {
  return path === HANDOFF_STATE_PATH || path === HANDOFF_MARKDOWN_PATH;
}

/** Machine-local bookkeeping and old generic-sync artifacts never propagate. */
export function isExcludedHandoffPath(path) {
  return path === MEMMESH_MIRROR_PATH
    || LEGACY_STATE_RE.test(path)
    || LEGACY_MARKDOWN_RE.test(path)
    || HANDOFF_BACKUP_RE.test(path);
}

export function parseHandoffState(content) {
  try {
    const state = JSON.parse(content);
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    const savedAt = typeof state.saved_at === 'string' ? Date.parse(state.saved_at) : NaN;
    if (!Number.isFinite(savedAt)) return null;
    const generation = Number.isInteger(state.handoff_generation) && state.handoff_generation > 0
      ? state.handoff_generation
      : 0;
    return { state, savedAt, generation };
  } catch {
    return null;
  }
}

function candidateOrder(a, b, useGeneration) {
  if (useGeneration && a.generation !== b.generation) {
    return b.generation - a.generation;
  }
  if (a.savedAt !== b.savedAt) return b.savedAt - a.savedAt;
  const pushedA = Number.isFinite(a.file.pushed_at) ? a.file.pushed_at : 0;
  const pushedB = Number.isFinite(b.file.pushed_at) ? b.file.pushed_at : 0;
  if (pushedA !== pushedB) return pushedB - pushedA;
  return String(a.file.machine_id).localeCompare(String(b.file.machine_id));
}

export function selectNewestRemoteHandoff(files, local = null) {
  const invalid = [];
  const candidates = [];
  for (const file of files) {
    if (file.path !== HANDOFF_STATE_PATH || file.deleted) continue;
    const parsed = parseHandoffState(file.content);
    if (!parsed) {
      invalid.push(file);
      continue;
    }
    candidates.push({ file, ...parsed });
  }
  // Comparison mode belongs to the complete candidate set. If a legacy local
  // state has no generation, every candidate must fall back to saved_at;
  // reducing remotes by generation first would make the result non-transitive.
  const useGeneration = candidates.length > 0
    && candidates.every((candidate) => candidate.generation > 0)
    && (!local || local.generation > 0);
  candidates.sort((a, b) => candidateOrder(a, b, useGeneration));
  return { candidate: candidates[0] ?? null, invalid, useGeneration };
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.sync-tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

/**
 * Promote the newest remote handoff when it is newer than the local candidate.
 * Tombstones are intentionally ignored: one machine ending/deleting its local
 * handoff must never erase another machine's restorable state.
 */
export function reconcileHandoff(xmDir, files) {
  const localPath = join(xmDir, HANDOFF_STATE_PATH);
  const hadLocal = existsSync(localPath);
  let local = null;
  if (hadLocal) {
    try { local = parseHandoffState(readFileSync(localPath, 'utf8')); } catch {}
  }

  const { candidate, invalid, useGeneration } = selectNewestRemoteHandoff(files, local);
  if (!candidate) return { status: 'none', invalid: invalid.length };

  const localIsNewer = local && (
    (useGeneration && local.generation > candidate.generation)
    || (useGeneration && local.generation === candidate.generation && local.savedAt >= candidate.savedAt)
    || (!useGeneration && local.savedAt >= candidate.savedAt)
  );
  if (localIsNewer) {
    writeAtomic(join(xmDir, HANDOFF_MARKDOWN_PATH), HANDOFF_POINTER);
    return {
      status: 'kept-local',
      saved_at: local.state.saved_at,
      machine_id: candidate.file.machine_id,
      invalid: invalid.length,
    };
  }

  writeAtomic(localPath, candidate.file.content);

  // Never trust a remote Markdown snapshot as a second source of truth. The
  // canonical JSON was selected above; regenerate the stable pointer locally.
  const markdownPath = join(xmDir, HANDOFF_MARKDOWN_PATH);
  writeAtomic(markdownPath, HANDOFF_POINTER);

  return {
    status: 'updated',
    saved_at: candidate.state.saved_at,
    machine_id: candidate.file.machine_id,
    markdown: true,
    replaced_invalid_local: hadLocal && !local,
    invalid: invalid.length,
  };
}
