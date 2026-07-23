/**
 * Shared cost primitives.
 *
 * This module deliberately knows nothing about x-build configuration or CLI
 * state. Callers provide the event file and budget values, keeping dashboard,
 * prediction, cache, and budget features on a single dependency direction.
 */

import {
  appendFileSync, existsSync, mkdirSync, renameSync, rmdirSync, statSync,
  truncateSync, unlinkSync, readFileSync, writeFileSync, readdirSync, lstatSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, normalize, relative, resolve } from 'node:path';

export const COST_EVENT_MAX_BYTES = 4 * 1024;
export const CACHE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * Resolve cache expiry with a deliberately small configuration surface.
 * `ttlMs` / `ttlDays` are call-site overrides; `config.cache.ttl_days` is
 * the persisted setting. Zero and invalid values are rejected rather than
 * silently turning a seven-day cache into a permanent cache.
 */
export function resolveCacheTtlMs({ ttlMs, ttlDays, config } = {}) {
  let value = ttlMs;
  let multiplier = 1;
  if (value === undefined && ttlDays !== undefined) {
    value = ttlDays;
    multiplier = 24 * 60 * 60 * 1000;
  }
  if (value === undefined && config?.cache?.ttl_days !== undefined) {
    value = config.cache.ttl_days;
    multiplier = 24 * 60 * 60 * 1000;
  }
  if (value === undefined || value === null) return CACHE_DEFAULT_TTL_MS;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new TypeError('cache TTL must be a positive finite number');
  }
  const result = numeric * multiplier;
  if (!Number.isFinite(result) || result <= 0) {
    throw new TypeError('cache TTL must be a positive finite number');
  }
  return result;
}

/**
 * Pure expiry classification. Exact expiry is a miss (`age >= ttl`). Future
 * timestamps are retained: a clock-skewed row must not make GC delete data.
 * Entries without a usable timestamp are misses, but are not automatically
 * destructive candidates for GC.
 */
export function cacheExpiry(entry, { now = Date.now(), ttlMs, ttlDays, config } = {}) {
  const current = Number(now);
  if (!Number.isFinite(current)) throw new TypeError('now must be a finite epoch millisecond value');
  const ttl = resolveCacheTtlMs({ ttlMs, ttlDays, config });
  const lastHit = timestampMs(entry?.last_hit);
  const created = timestampMs(entry?.created);
  const timestamp = Number.isFinite(lastHit) ? lastHit : created;
  if (!Number.isFinite(timestamp)) return { expired: true, prune: false, reason: 'invalid_timestamp', ttl_ms: ttl };
  const age = current - timestamp;
  if (age < 0) return { expired: false, prune: false, reason: 'future_timestamp', timestamp_ms: timestamp, age_ms: age, ttl_ms: ttl };
  return {
    expired: age >= ttl,
    prune: age >= ttl,
    reason: age >= ttl ? 'expired' : 'fresh',
    timestamp_ms: timestamp,
    age_ms: age,
    ttl_ms: ttl,
  };
}

// These are deliberately recognizers rather than redactors. Cache records are
// long-lived local artifacts, so a likely credential must fail closed before a
// cache directory, record, or index row is created. The minimum token lengths
// avoid treating prose such as "sk-test" or a document heading containing
// "BEGIN" as a secret.
const CACHE_SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|OPENSSH PRIVATE KEY)-----/i,
];
const CACHE_HASH_FIELD_RE = /(?:^|[_-])(?:hash|sha|sha256|digest)(?:$|[_-])/i;
const CACHE_FRAGMENT_FIELD_RE = /(?:part|chunk|fragment|segment|token|content|text|prompt|response|input|output|file)/i;

function isPlainObject(value) {
  return value && Object.getPrototypeOf(value) === Object.prototype;
}

function hasSecretText(value) {
  if (CACHE_SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  // Credentials are commonly wrapped by transport or formatted output. Removing
  // whitespace (including zero-width separators) catches a split token without
  // joining arbitrary punctuation-delimited prose into a new credential.
  const compact = value.replace(/[\s\u200B\u200C\u200D]+/g, '');
  return compact !== value && CACHE_SECRET_PATTERNS.some((pattern) => pattern.test(compact));
}

function hasAdjacentSecret(values) {
  let previous = null;
  for (const value of values) {
    if (typeof value !== 'string') {
      previous = null;
      continue;
    }
    const compact = value.replace(/[\s\u200B\u200C\u200D]+/g, '');
    if (previous !== null && hasSecretText(previous + compact)) return true;
    previous = compact;
  }
  return false;
}

function hasAdjacentObjectSecret(record) {
  let previous = null;
  for (const [key, value] of Object.entries(record)) {
    // Object fields are often unrelated metadata. Only join explicit fragment
    // carriers; arrays already preserve caller order and are always checked.
    if (typeof value !== 'string' || !CACHE_FRAGMENT_FIELD_RE.test(key)) {
      previous = null;
      continue;
    }
    const compact = value.replace(/[\s\u200B\u200C\u200D]+/g, '');
    if (previous !== null && hasSecretText(previous + compact)) return true;
    previous = compact;
  }
  return false;
}

function hasCacheSecret(value, ancestors = new Set()) {
  if (typeof value === 'string') return hasSecretText(value);
  if (Buffer.isBuffer(value)) return hasCacheSecret(value.toString('utf8'), ancestors);
  if (!value || typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.some((item) => hasCacheSecret(item, ancestors)) || hasAdjacentSecret(value);
    }
    if (isPlainObject(value)) {
      const values = Object.values(value);
      return values.some((item) => hasCacheSecret(item, ancestors)) || hasAdjacentObjectSecret(value);
    }
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function cacheContentHash(value) {
  return createHash('sha256').update('xm-cache-content-v1\0').update(value, 'utf8').digest('hex');
}

function hashOnlyCacheEntry(value, ancestors = new Set()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    return { sha256: cacheContentHash(value), bytes: Buffer.byteLength(value, 'utf8') };
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('cache entry must not contain cyclic values');
    ancestors.add(value);
    try {
      return value.map((item) => typeof item === 'string'
        ? { sha256: cacheContentHash(item), bytes: Buffer.byteLength(item, 'utf8') }
        : hashOnlyCacheEntry(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isPlainObject(value)) throw new TypeError('cache entry must contain only JSON-compatible values');
  if (ancestors.has(value)) throw new TypeError('cache entry must not contain cyclic values');
  ancestors.add(value);
  try {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (typeof item === 'string' && !CACHE_HASH_FIELD_RE.test(key)) {
        const hashKey = Object.hasOwn(value, `${key}_hash`) ? `${key}_content_hash` : `${key}_hash`;
        result[hashKey] = cacheContentHash(item);
        result[`${key}_bytes`] = Buffer.byteLength(item, 'utf8');
      } else if (typeof item === 'string') {
        // Hash/digest fields are already the non-content compatibility format
        // used by the R15 API; retain them byte-for-byte.
        result[key] = item;
      } else {
        result[key] = hashOnlyCacheEntry(item, ancestors);
      }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Prepare an opaque cache record without retaining request/response content by
 * default. `storeContent` (or `config.cache.store_content`) must be explicitly
 * true to preserve raw fields; hashes and byte counts remain sufficient for the
 * default audit/index use case.
 */
export function prepareCacheEntry(entry, { storeContent, config } = {}) {
  if (!entry || !isPlainObject(entry)) throw new TypeError('cache entry must be an object');
  if (storeContent !== undefined && typeof storeContent !== 'boolean') {
    throw new TypeError('storeContent must be a boolean when supplied');
  }
  if (hasCacheSecret(entry)) {
    const error = new Error('cache write rejected: secret-like content detected');
    error.code = 'CACHE_SECRET_DETECTED';
    throw error;
  }
  const enabled = storeContent === true || (storeContent === undefined && config?.cache?.store_content === true);
  return enabled ? canonicalize(entry) : canonicalize(hashOnlyCacheEntry(entry));
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
 * Atomically persist one cache record and append its index observation. Raw
 * content is hash-only unless the caller explicitly opts in with
 * `storeContent: true` or `config.cache.store_content: true`. A suspected
 * credential rejects before this function creates any cache path.
 *
 * The first writer for a hash wins; later writes retain that record and only
 * advance last_hit.
 */
export function writeCacheEntry({
  cacheDir = '.xm/cache', model, hash, entry, now = Date.now(), storeContent, config,
  // `request`, `input`, `content`, and `files` are optional non-persisted
  // caller payloads. Supporting them lets an integration reject a secret in
  // source material even when only its hash is placed in `entry`.
  request, input, content, files,
} = {}) {
  if (hasCacheSecret(request) || hasCacheSecret(input) || hasCacheSecret(content) || hasCacheSecret(files)) {
    const error = new Error('cache write rejected: secret-like content detected');
    error.code = 'CACHE_SECRET_DETECTED';
    throw error;
  }
  const preparedEntry = prepareCacheEntry(entry, { storeContent, config });
  const filePath = cacheEntryPath({ cacheDir, model, hash });
  const indexPath = cacheIndexPath(cacheDir, model);
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
        stored = { schema_v: 1, hash, created, last_hit, entry: preparedEntry };
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
export function readCacheEntry({ cacheDir = '.xm/cache', model, hash, now, ttlMs, ttlDays, config } = {}) {
  const filePath = cacheEntryPath({ cacheDir, model, hash });
  if (!existsSync(filePath)) return null;
  let record;
  try {
    record = readStoredCacheEntry(filePath);
  } catch (error) {
    // GC may unlink an expired entry between existsSync and readFileSync. That
    // is indistinguishable from an ordinary miss to a lookup caller.
    if (error?.cause?.code === 'ENOENT' || error?.code === 'ENOENT') return null;
    throw error;
  }
  // Expired and legacy timestamp-less records remain on disk until a deliberate
  // GC pass. Lookup treats both as a miss, so an interrupted or concurrent GC
  // can never cause a false hit or force destructive cleanup on the read path.
  if (cacheExpiry(record, { now, ttlMs, ttlDays, config }).expired) return null;
  return record;
}

/**
 * Append the explicit cost avoided by a cache hit. The caller must provide a
 * measured/quoted model cost; missing, estimated, or non-positive values do
 * not create a made-up saving event.
 */
export function recordCacheHit({ filePath, savedUsd, model, hash, timestamp = new Date().toISOString(), project } = {}) {
  const saved = Number(savedUsd);
  if (!Number.isFinite(saved) || saved <= 0) return null;
  const event = { type: 'cache_hit', saved_usd: saved, timestamp };
  if (typeof model === 'string' && model) event.model = model;
  if (typeof hash === 'string' && CACHE_HASH_RE.test(hash)) event.cache_hash = hash;
  if (typeof project === 'string' && project) event.project = project;
  return appendCostEvent({ filePath, event });
}

function safeCacheNode(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function safeCacheEntryNode(cacheDir, model, hash) {
  const root = resolveCacheRoot(cacheDir);
  const parts = [root, join(root, model), join(root, model, hash.slice(0, 2)), join(root, model, hash.slice(0, 2), hash.slice(2, 4))];
  for (const part of parts) {
    const node = safeCacheNode(part);
    if (node?.isSymbolicLink()) return null;
  }
  const filePath = cacheEntryPath({ cacheDir, model, hash });
  const file = safeCacheNode(filePath);
  return file?.isFile() && !file.isSymbolicLink() ? { filePath, file } : null;
}

function readCacheIndexRows(indexPath) {
  const index = safeCacheNode(indexPath);
  if (!index?.isFile() || index.isSymbolicLink()) return [];
  try {
    const rows = [];
    for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === 'object' && !Array.isArray(row) && typeof row.hash === 'string' && CACHE_HASH_RE.test(row.hash)) rows.push(row);
      } catch { /* malformed/torn index rows are compacted away */ }
    }
    return rows;
  } catch { return []; }
}

function atomicReplaceIndex(indexPath, rows) {
  return atomicWriteText(indexPath, rows.map((row) => JSON.stringify(row)).join(rows.length ? '\n' : '') + (rows.length ? '\n' : ''));
}

/**
 * Compact append-only indexes and prune only entries proved expired. It never
 * follows symlinks, ignores torn rows, and keeps timestamp-less/future records
 * as non-destructive "unverifiable" rows. `dryRun` computes exactly the same
 * result without changing entries or indexes.
 */
export function gcCache({ cacheDir = '.xm/cache', model, now = Date.now(), ttlMs, ttlDays, config, dryRun = false } = {}) {
  if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean');
  const root = resolveCacheRoot(cacheDir);
  const ttl = resolveCacheTtlMs({ ttlMs, ttlDays, config });
  const models = model === undefined || model === null
    ? (safeCacheNode(root)?.isDirectory() ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && MODEL_SEGMENT_RE.test(entry.name))
      .map((entry) => entry.name) : [])
    : [validateModelSegment(model)];
  const result = { models: 0, index_rows_before: 0, index_rows_after: 0, pruned: 0, retained_unverifiable: 0, missing: 0, malformed: 0, dry_run: dryRun, ttl_ms: ttl };

  for (const safeModel of models) {
    const modelDir = join(root, safeModel);
    const modelNode = safeCacheNode(modelDir);
    if (!modelNode?.isDirectory()) continue;
    const indexPath = cacheIndexPath(root, safeModel);
    const indexNode = safeCacheNode(indexPath);
    if (indexNode?.isSymbolicLink()) continue;
    result.models += 1;
    // Index lock ordering matches writeCacheEntry: index first, then entry.
    const release = acquireWriteLock(indexPath);
    try {
      const rows = readCacheIndexRows(indexPath);
      result.index_rows_before += rows.length;
      const latest = new Map();
      for (const row of rows) latest.set(row.hash, row);
      const compacted = [];
      for (const [hash, row] of latest) {
        let node;
        try { node = safeCacheEntryNode(root, safeModel, hash); } catch { node = null; }
        if (!node) { result.missing += 1; continue; }
        const releaseEntry = acquireWriteLock(node.filePath);
        try {
          // Re-check after acquiring the lock: a concurrent GC/writer (or a
          // hostile symlink swap) must not make us follow the pre-lock inode.
          node = safeCacheEntryNode(root, safeModel, hash);
          if (!node) { result.missing += 1; continue; }
          let record;
          try { record = readStoredCacheEntry(node.filePath); } catch { result.malformed += 1; continue; }
          if (record.hash !== hash) { result.malformed += 1; continue; }
          const expiry = cacheExpiry(record, { now, ttlMs: ttl });
          if (expiry.prune) {
            result.pruned += 1;
            if (!dryRun) unlinkSync(node.filePath);
            continue;
          }
          if (expiry.reason === 'invalid_timestamp') result.retained_unverifiable += 1;
          const size = node.file.size;
          compacted.push({ hash, created: record.created, last_hit: record.last_hit, size });
        } finally {
          releaseEntry();
        }
      }
      result.index_rows_after += compacted.length;
      if (!dryRun && indexNode?.isFile()) atomicReplaceIndex(indexPath, compacted);
    } finally {
      release();
    }
  }
  return result;
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
