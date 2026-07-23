/**
 * Shared cost primitives.
 *
 * This module deliberately knows nothing about x-build configuration or CLI
 * state. Callers provide the event file and budget values, keeping dashboard,
 * prediction, cache, and budget features on a single dependency direction.
 */

import {
  appendFileSync, existsSync, mkdirSync, renameSync, rmdirSync, statSync,
  truncateSync, unlinkSync, readFileSync, writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, normalize, relative, resolve } from 'node:path';

export const COST_EVENT_MAX_BYTES = 4 * 1024;

const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;
const STALE_LOCK_MS = 10_000;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(LOCK_SLEEP, 0, 0, ms);
}

function requireFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new TypeError('cost core: filePath must be a non-empty string');
  }
}

function acquireWriteLock(filePath) {
  const lockPath = filePath + '.lock';
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
    try {
      // mkdir is atomic on local and network filesystems. A directory lock
      // avoids O_EXCL weaknesses seen with ordinary lock files on NFS.
      mkdirSync(lockPath);
      return () => rmdirSync(lockPath);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const lockStat = statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          if (lockStat.isDirectory()) rmdirSync(lockPath);
          else unlinkSync(lockPath); // migration path for legacy file locks
          continue;
        }
      } catch (staleError) {
        if (staleError?.code === 'ENOENT') continue;
        throw staleError;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  throw new Error(`appendCostEvent: could not acquire lock for ${filePath}`);
}

/**
 * Read a JSONL cost log. Malformed/torn lines are intentionally ignored so a
 * reader remains available after an interrupted writer.
 */
export function readCostEvents({ filePath } = {}) {
  requireFilePath(filePath);
  if (!existsSync(filePath)) return [];
  try {
    const events = [];
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
      } catch { /* skip malformed/torn JSONL rows */ }
    }
    return events;
  } catch {
    return [];
  }
}

/**
 * Append one event under the shared 4KB and atomic-lock contract.
 *
 * `rotateAtBytes` is optional because rotation is a metrics-log policy, not a
 * requirement for future event stores. It is nevertheless performed while the
 * same lock is held, preserving the existing x-build writer's race guarantee.
 */
export function appendCostEvent({ filePath, event, maxBytes = COST_EVENT_MAX_BYTES, rotateAtBytes = null } = {}) {
  requireFilePath(filePath);
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('appendCostEvent: event must be an object');
  }
  const requestedMaxBytes = Number(maxBytes);
  if (!Number.isFinite(requestedMaxBytes) || requestedMaxBytes <= 0) {
    throw new TypeError('appendCostEvent: maxBytes must be a positive finite number');
  }
  // Callers may opt into a smaller event budget, but the shared t2 contract
  // always remains an absolute 4KB ceiling.
  const payloadLimit = Math.min(requestedMaxBytes, COST_EVENT_MAX_BYTES);
  const serialized = JSON.stringify(event);
  const payloadBytes = Buffer.byteLength(serialized, 'utf8');
  if (payloadBytes > payloadLimit) {
    throw new Error(
      `appendCostEvent: payload ${payloadBytes} bytes exceeds ${payloadLimit} bytes; ` +
      'move large fields to refs-out and store only their reference.',
    );
  }

  mkdirSync(dirname(filePath), { recursive: true });
  const release = acquireWriteLock(filePath);
  try {
    if (rotateAtBytes != null) {
      // Rotation is opportunistic. Any exists→stat race or rename conflict
      // must not drop the new event from the active log.
      try {
        if (existsSync(filePath) && statSync(filePath).size > rotateAtBytes) {
          renameSync(filePath, filePath + '.1');
        }
      } catch { /* append active log */ }
    }
    appendFileSync(filePath, serialized + '\n', 'utf8');
  } finally {
    release();
  }
  return event;
}

function timestampMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return NaN;
}

/**
 * Sum valid numeric `cost_usd` values and retain project subtotals. `since`
 * is an epoch-ms lower bound; timestamp-less rows are excluded when it is set.
 */
export function computeSpend(events, { since = null } = {}) {
  const cutoff = since == null ? null : Number(since);
  const spentByProject = {};
  let spent = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const cost = event.cost_usd;
    if (typeof cost !== 'number' || !Number.isFinite(cost)) continue;
    if (cutoff != null && (!Number.isFinite(cutoff) || timestampMs(event.timestamp) < cutoff)) continue;
    spent += cost;
    if (typeof event.project === 'string' && event.project !== '') {
      spentByProject[event.project] = (spentByProject[event.project] ?? 0) + cost;
    }
  }
  return { spent, projectSpentMap: spentByProject };
}

function canonicalize(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('getCacheKey: numbers must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('getCacheKey: cyclic values are not supported');
    ancestors.add(value);
    const canonical = value.map((item) => canonicalize(item, ancestors));
    ancestors.delete(value);
    return canonical;
  }
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    if (ancestors.has(value)) throw new TypeError('getCacheKey: cyclic values are not supported');
    ancestors.add(value);
    const canonical = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) throw new TypeError('getCacheKey: undefined values are not supported');
      canonical[key] = canonicalize(value[key], ancestors);
    }
    ancestors.delete(value);
    return canonical;
  }
  throw new TypeError('getCacheKey: input must contain only JSON-compatible values');
}

/**
 * Return a versioned SHA-256 key for canonical JSON. Object keys are sorted;
 * array order is semantic, so callers (notably the later cache storage task)
 * must sort any order-insensitive collections such as file descriptors first.
 */
export function getCacheKey(input) {
  const canonical = JSON.stringify(canonicalize(input));
  return createHash('sha256').update('xm-cost-key-v1\0').update(canonical, 'utf8').digest('hex');
}

const CACHE_KEY_FIELDS = new Set([
  'model', 'model_version', 'temperature', 'system_prompt_hash',
  'tool_schema_hash', 'prompt', 'file_hashes', 'files',
]);
const CACHE_HASH_RE = /^[a-f0-9]{64}$/;
const CONTENT_SHA_RE = /^[a-fA-F0-9]{64}$/;
const MODEL_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function cacheText(value, field, fallback = '') {
  if (value == null) return fallback;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  // A cache false hit is worse than a miss: preserve all LLM input text byte
  // exact (including Unicode form and line endings). Only file-path syntax and
  // numeric temperature have deliberately documented normalization below.
  return value;
}

function cacheTemperature(value) {
  if (value == null) return 0;
  if (typeof value === 'string') {
    const source = value.trim();
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(source)) {
      throw new TypeError('temperature must be a finite number or numeric string');
    }
    value = Number(source);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('temperature must be a finite number or numeric string');
  }
  return Object.is(value, -0) ? 0 : value;
}

function normalizeCacheFilePath(value) {
  const raw = cacheText(value, 'file_path');
  if (!raw) throw new TypeError('file_path must be a non-empty string');
  // File descriptors are project-relative identifiers, not filesystem paths to
  // open. Normalize Windows separators, remove a harmless leading ./, and
  // reject absolute or parent traversal spellings so aliases cannot split keys.
  const slashPath = raw.replace(/\\/g, '/');
  if (slashPath.startsWith('/') || /^[A-Za-z]:\//.test(slashPath)) {
    throw new TypeError('file_path must be project-relative');
  }
  const normalized = normalize(slashPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new TypeError('file_path must not escape the project');
  }
  return normalized;
}

function normalizeCacheFiles(files) {
  if (files == null) return [];
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  const normalized = files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw new TypeError('each file must be an object');
    }
    const keys = Object.keys(file);
    if (keys.some((key) => key !== 'file_path' && key !== 'content_sha')) {
      throw new TypeError('each file may contain only file_path and content_sha');
    }
    const file_path = normalizeCacheFilePath(file.file_path);
    const content_sha = cacheText(file.content_sha, 'content_sha');
    if (!CONTENT_SHA_RE.test(content_sha)) {
      throw new TypeError('content_sha must be a SHA-256 64-hex digest');
    }
    return { file_path, content_sha };
  });
  // Do not use localeCompare: its ICU collation can vary across machines.
  normalized.sort((left, right) => {
    if (left.file_path < right.file_path) return -1;
    if (left.file_path > right.file_path) return 1;
    if (left.content_sha < right.content_sha) return -1;
    if (left.content_sha > right.content_sha) return 1;
    return 0;
  });
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i - 1].file_path === normalized[i].file_path) {
      throw new TypeError(`duplicate file_path after normalization: ${normalized[i].file_path}`);
    }
  }
  return normalized;
}

/**
 * Build the R14 cache-key payload. This is intentionally separate from the
 * generic getCacheKey API: generic arrays retain their caller-supplied order,
 * while only the R14 `file_hashes` collection is order-insensitive and sorted.
 * `files` remains a temporary input alias for callers that adopted an earlier
 * draft; it is normalized to the canonical `file_hashes` output.
 */
export function buildCacheKeyInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('cache key input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!CACHE_KEY_FIELDS.has(key)) throw new TypeError(`unknown cache key field: ${key}`);
  }
  if (input.file_hashes != null && input.files != null) {
    throw new TypeError('use file_hashes or files, not both');
  }
  const model = cacheText(input.model, 'model');
  if (!model) throw new TypeError('model must be a non-empty string');
  validateModelSegment(model);
  return {
    model,
    model_version: cacheText(input.model_version, 'model_version'),
    temperature: cacheTemperature(input.temperature),
    system_prompt_hash: cacheText(input.system_prompt_hash, 'system_prompt_hash'),
    tool_schema_hash: cacheText(input.tool_schema_hash, 'tool_schema_hash'),
    prompt: cacheText(input.prompt, 'prompt'),
    file_hashes: normalizeCacheFiles(input.file_hashes ?? input.files),
  };
}

/** Return the R14 SHA-256 key for a normalized cache request. */
export function getRequestCacheKey(input = {}) {
  return getCacheKey(buildCacheKeyInput(input));
}

function validateCacheHash(hash) {
  if (typeof hash !== 'string' || !CACHE_HASH_RE.test(hash)) {
    throw new TypeError('cache hash must be a lowercase SHA-256 64-hex digest');
  }
  return hash;
}

function validateModelSegment(model) {
  if (typeof model !== 'string' || !MODEL_SEGMENT_RE.test(model) || model === '.' || model === '..') {
    throw new TypeError('cache model must be one safe path segment');
  }
  return model;
}

function resolveCacheRoot(cacheDir) {
  if (typeof cacheDir !== 'string' || !cacheDir) throw new TypeError('cacheDir must be a non-empty string');
  return resolve(cacheDir);
}

/** Resolve an R15 entry path without allowing the model component to traverse cacheDir. */
export function cacheEntryPath({ cacheDir = '.xm/cache', model, hash } = {}) {
  const root = resolveCacheRoot(cacheDir);
  const safeModel = validateModelSegment(model);
  const safeHash = validateCacheHash(hash);
  const result = join(root, safeModel, safeHash.slice(0, 2), safeHash.slice(2, 4), `${safeHash}.json`);
  if (relative(root, result).startsWith('..')) throw new Error('cache entry escapes cacheDir');
  return result;
}

function cacheIndexPath(cacheDir, model) {
  const root = resolveCacheRoot(cacheDir);
  const safeModel = validateModelSegment(model);
  return join(root, safeModel, 'index.jsonl');
}

function cacheTimestamp(now) {
  const time = Number(now);
  if (!Number.isFinite(time)) throw new TypeError('now must be a finite epoch millisecond value');
  return new Date(time).toISOString();
}

function readStoredCacheEntry(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch (error) {
    throw new Error(`cache entry is malformed: ${filePath}`, { cause: error });
  }
}

function atomicWriteText(filePath, serialized) {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(tempPath, serialized, 'utf8');
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') error.temp_cleanup_error = cleanupError;
    }
    throw error;
  }
  return Buffer.byteLength(serialized, 'utf8');
}

function atomicWriteJson(filePath, value) {
  return atomicWriteText(filePath, JSON.stringify(canonicalize(value)) + '\n');
}

function rollbackCacheWrite({
  filePath, previousEntryText, indexPath, indexExisted, indexSize,
}) {
  const errors = [];
  try {
    if (previousEntryText == null) unlinkSync(filePath);
    else atomicWriteText(filePath, previousEntryText);
  } catch (error) {
    if (error?.code !== 'ENOENT' || previousEntryText != null) errors.push(error);
  }
  try {
    if (!indexExisted) {
      if (existsSync(indexPath) && statSync(indexPath).isFile()) unlinkSync(indexPath);
    } else if (indexSize != null) {
      truncateSync(indexPath, indexSize);
    }
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

function throwCacheRollbackError(originalError, rollbackErrors) {
  if (rollbackErrors.length === 0) throw originalError;
  const details = rollbackErrors.map((error) => error?.message || String(error)).join('; ');
  const combined = new AggregateError(
    [originalError, ...rollbackErrors],
    `cache index append failed: ${originalError?.message || originalError}; rollback failed: ${details}`,
  );
  combined.cause = originalError;
  combined.code = 'CACHE_ROLLBACK_FAILED';
  throw combined;
}

/**
 * Atomically persist one opaque cache record and append its index observation.
 * The first writer for a hash wins; later writes retain that record and only
 * advance last_hit. R16's content policy intentionally belongs to its follow-up
 * task, so this function neither inspects nor synthesizes response content.
 */
export function writeCacheEntry({ cacheDir = '.xm/cache', model, hash, entry, now = Date.now() } = {}) {
  const filePath = cacheEntryPath({ cacheDir, model, hash });
  const indexPath = cacheIndexPath(cacheDir, model);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('cache entry must be an object');
  }
  const last_hit = cacheTimestamp(now);
  mkdirSync(dirname(filePath), { recursive: true });
  // Keep record persistence and the matching index observation in one index
  // lock scope. This serializes index rows with the actual record transition,
  // avoiding a later writer appending before an earlier one.
  mkdirSync(dirname(indexPath), { recursive: true });
  const releaseIndex = acquireWriteLock(indexPath);
  let created;
  let written = false;
  let size;
  try {
    const releaseEntry = acquireWriteLock(filePath);
    try {
      const indexExisted = existsSync(indexPath);
      let indexSize = null;
      if (indexExisted) {
        const indexStat = statSync(indexPath);
        if (indexStat.isFile()) indexSize = indexStat.size;
      }
      let stored;
      let previousEntryText = null;
      if (existsSync(filePath)) {
        previousEntryText = readFileSync(filePath, 'utf8');
        stored = readStoredCacheEntry(filePath);
        if (stored.hash !== hash || typeof stored.created !== 'string') {
          throw new Error(`cache entry identity is invalid: ${filePath}`);
        }
        created = stored.created;
        stored.last_hit = last_hit;
      } else {
        created = last_hit;
        stored = { schema_v: 1, hash, created, last_hit, entry: canonicalize(entry) };
        written = true;
      }
      size = atomicWriteJson(filePath, stored);
      try {
        appendFileSync(indexPath, JSON.stringify({ hash, created, last_hit, size }) + '\n', 'utf8');
      } catch (appendError) {
        const rollbackErrors = rollbackCacheWrite({
          filePath, previousEntryText, indexPath, indexExisted, indexSize,
        });
        throwCacheRollbackError(appendError, rollbackErrors);
      }
    } finally {
      releaseEntry();
    }
  } finally {
    releaseIndex();
  }
  const index = { hash, created, last_hit, size };
  return { ...index, path: filePath, index_path: indexPath, written };
}

/** Read an R15 record; missing entries are a cache miss rather than an error. */
export function readCacheEntry({ cacheDir = '.xm/cache', model, hash } = {}) {
  const filePath = cacheEntryPath({ cacheDir, model, hash });
  if (!existsSync(filePath)) return null;
  return readStoredCacheEntry(filePath);
}

/**
 * Evaluate a proposed spend without mutating state. A cap is exceeded only
 * above 100%. `warnAtUsd`, when supplied, is an exclusive dollar threshold;
 * otherwise the legacy ratio-based `warnAt` boundary preserves existing 80%
 * budget behavior.
 */
export function checkHardCap({ spent = 0, cap, additionalCost = 0, warnAt = 0.8, warnAtUsd } = {}) {
  const budget = Number(cap);
  if (!Number.isFinite(budget) || budget <= 0) return { ok: true, budget: null };
  const current = Number(spent);
  const additional = Number(additionalCost);
  const projected = (Number.isFinite(current) ? current : 0) + (Number.isFinite(additional) ? additional : 0);
  const pct = projected / budget * 100;
  const explicitWarn = Number(warnAtUsd);
  const warningThreshold = Number.isFinite(explicitWarn) && explicitWarn > 0 && explicitWarn < budget
    ? explicitWarn
    : budget * Number(warnAt);
  if (projected > budget) return { ok: false, spent: Number.isFinite(current) ? current : 0, projected, budget, pct, level: 'exceeded' };
  if (projected > warningThreshold) return { ok: true, spent: Number.isFinite(current) ? current : 0, projected, budget, pct, warn_at_usd: warningThreshold, level: 'warning' };
  return { ok: true, spent: Number.isFinite(current) ? current : 0, projected, budget, pct, warn_at_usd: warningThreshold, level: 'normal' };
}
