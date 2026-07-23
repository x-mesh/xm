/**
 * Deterministic replay artifact builder for x-trace.
 *
 * A legacy trace does not contain provider credentials or arbitrary tool I/O, so
 * this module deliberately does not pretend to re-run an agent.  Instead it
 * freezes the recorded span context, deterministic seed and a safe filesystem
 * snapshot into an auditable replay artifact.  A later provider adapter can use
 * that artifact without changing this persistence contract.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveTraceDir } from './trace-writer.mjs';

export const SNAPSHOT_WARNING_BYTES = 10 * 1024 * 1024;
const MAX_FORK_POINTS = 3;
// Replay uses the same canonical cost/routing tiers as x-build.  Accepting an
// arbitrary identifier here turns the manifest into a secret-storage sink.
const REPLAY_MODEL_OVERRIDES = new Set(['haiku', 'sonnet', 'opus']);
const CREDENTIAL_SHAPED = /(?:sk[-_][A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|(?:api[_-]?key|secret|token|password|authorization)[-_][A-Za-z0-9_-]{20,})/i;

function safeId(value, name) {
  if (typeof value === 'string' && CREDENTIAL_SHAPED.test(value)) {
    throw new Error(`${name} must not be credential-shaped`);
  }
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value.includes('..')) {
    throw new Error(`${name} must be a safe trace identifier`);
  }
  return value;
}

function atomicWrite(path, value) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, value, 'utf8');
  renameSync(tmp, path);
}

/** A small lock with stale-lock recovery. Fork allocation must never be unlocked. */
function withLock(path, fn) {
  const lock = `${path}.lock`;
  let fd = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock);
      } catch { /* another writer changed the lock; retry */ }
      const until = Date.now() + 10;
      while (Date.now() < until) { /* synchronous CLI: short bounded backoff */ }
    }
  }
  if (fd === null) throw new Error(`could not acquire replay fork lock: ${lock}`);
  try { return fn(); } finally {
    try { closeSync(fd); } catch {}
    try { unlinkSync(lock); } catch {}
  }
}

function readTrace(traceId) {
  const dir = resolveTraceDir();
  const path = resolve(dir, `${safeId(traceId, 'trace id')}.jsonl`);
  if (dirname(path) !== resolve(dir)) throw new Error('trace path escaped trace directory');
  if (!existsSync(path)) throw new Error(`trace not found: ${traceId}`);

  // A trace is untrusted input.  Resolve and open it without following a final
  // symlink, so a link (or a swap between validation and read) cannot import
  // arbitrary host content into a replay manifest.
  let fd;
  try {
    const dirReal = realpathSync(dir);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('trace must be a regular file inside trace directory');
    const targetReal = realpathSync(path);
    if (dirname(targetReal) !== dirReal) throw new Error('trace path escaped trace directory');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) throw new Error('trace must be a regular file inside trace directory');
  } catch (err) {
    if (fd != null) try { closeSync(fd); } catch {}
    if (err?.message?.startsWith('trace ')) throw err;
    throw new Error('trace must be a regular file inside trace directory');
  }
  let raw;
  try { raw = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
  const entries = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch { throw new Error(`corrupt trace JSONL at line ${index + 1}`); }
  }
  if (!entries.length) throw new Error(`trace is empty: ${traceId}`);
  return { raw, entries };
}

function resolveRepoRoot() {
  const out = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (out.error || out.status !== 0 || !out.stdout.trim()) {
    throw new Error('replay snapshot requires a git worktree');
  }
  return realpathSync(out.stdout.trim());
}

function trackedFiles(root) {
  // Replays snapshot reviewed source only. Untracked files are commonly local
  // prompts, credentials, or tool output and must not be copied into an
  // artifact merely because a user invoked replay.
  const out = spawnSync('git', ['ls-files', '-z', '--cached'], {
    cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (out.error || out.status !== 0) throw new Error('could not enumerate replay snapshot files');

  const result = [];
  const skipped = [];
  for (const name of out.stdout.toString('utf8').split('\0')) {
    if (!name) continue;
    // Replay output lives under .xm/.  Never include it: a second snapshot would
    // recursively archive old archives and make size warnings meaningless.
    if (name === '.xm' || name.startsWith('.xm/')) {
      skipped.push({ path: name, reason: 'replay_artifact' });
      continue;
    }
    // A newline cannot be represented safely by tar's -T format. It is omitted
    // rather than risking a second arbitrary archive member.
    if (name.includes('\n') || name.includes('\r') || name.startsWith('/') || name.split('/').includes('..')) {
      skipped.push({ path: name, reason: 'unsafe_relative_path' });
      continue;
    }
    const absolute = resolve(root, name);
    const rel = relative(root, absolute);
    if (!rel || rel.startsWith('..') || rel.includes('\\')) {
      skipped.push({ path: name, reason: 'unsafe_relative_path' });
      continue;
    }
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        skipped.push({ path: name, reason: 'not_regular_file' });
        continue;
      }
      const actual = realpathSync(absolute);
      const actualRel = relative(root, actual);
      if (actualRel.startsWith('..') || actualRel === '') {
        skipped.push({ path: name, reason: 'path_escapes_worktree' });
        continue;
      }
      if (/(?:^|\/)(?:\.?env|[^/]*(?:secret|credential|private|token|api[_-]?key|id_rsa)[^/]*|[^/]*\.pem)$/i.test(name)) {
        skipped.push({ path: name, reason: 'sensitive_path' });
        continue;
      }
      const contents = readFileSync(absolute, 'utf8');
      if (/(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_-]?key|authorization|secret|token|password)\s*[:=]\s*['"]?[^\s'"]+|\/(?:Users|home)\/[^/\s]+)/i.test(contents)) {
        skipped.push({ path: name, reason: 'sensitive_content' });
        continue;
      }
      result.push({ name, bytes: stat.size });
    } catch {
      skipped.push({ path: name, reason: 'unreadable' });
    }
  }
  return { files: result, skipped: skipped.reduce((counts, item) => {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
    return counts;
  }, {}) };
}

function makeSnapshot(root, destination) {
  const { files, skipped } = trackedFiles(root);
  const sourceBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const warnings = [];
  if (sourceBytes > SNAPSHOT_WARNING_BYTES) {
    warnings.push({ code: 'snapshot_size_over_10mb', phase: 'preflight', bytes: sourceBytes, limit_bytes: SNAPSHOT_WARNING_BYTES });
  }

  mkdirSync(dirname(destination), { recursive: true });
  const listPath = `${destination}.${process.pid}.${randomUUID()}.list`;
  const tmpArchive = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Prefix with ./ so even a legal filename beginning with '-' is data, not a tar option.
    writeFileSync(listPath, files.map((file) => `./${file.name}`).join('\n') + (files.length ? '\n' : ''), 'utf8');
    const tar = spawnSync('tar', ['-czf', tmpArchive, '-C', root, '-T', listPath], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (tar.error || tar.status !== 0) {
      throw new Error(`snapshot archive failed: ${(tar.stderr || tar.error?.message || 'tar failed').trim()}`);
    }
    renameSync(tmpArchive, destination);
  } finally {
    try { unlinkSync(listPath); } catch {}
    try { rmSync(tmpArchive, { force: true }); } catch {}
  }
  const archiveBytes = statSync(destination).size;
  if (archiveBytes > SNAPSHOT_WARNING_BYTES) {
    warnings.push({ code: 'snapshot_size_over_10mb', phase: 'postflight', bytes: archiveBytes, limit_bytes: SNAPSHOT_WARNING_BYTES });
  }
  return { archive_bytes: archiveBytes, source_bytes: sourceBytes, files: files.length, skipped, warnings };
}

function reserveFork(traceId, spanId) {
  const root = join(resolveTraceDir(), safeId(traceId, 'trace id'));
  mkdirSync(root, { recursive: true });
  const path = join(root, 'forks.json');
  return withLock(path, () => {
    let data = { v: 1, forks: [] };
    if (existsSync(path)) {
      try { data = JSON.parse(readFileSync(path, 'utf8')); }
      catch { throw new Error(`fork state is corrupt for trace: ${traceId}`); }
    }
    if (!Array.isArray(data?.forks)) throw new Error(`fork state is malformed for trace: ${traceId}`);
    if (data.forks.length >= MAX_FORK_POINTS) throw new Error(`fork point limit reached for trace ${traceId} (max ${MAX_FORK_POINTS})`);
    const fork = { id: `fork-${randomUUID()}`, span: spanId, index: data.forks.length + 1, created_at: new Date().toISOString() };
    data.v = 1;
    data.forks.push(fork);
    atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
    return { root, fork };
  });
}

function releaseFork(root, traceId, forkId) {
  const path = join(root, 'forks.json');
  withLock(path, () => {
    if (!existsSync(path)) return;
    let data;
    try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
    if (!Array.isArray(data?.forks)) return;
    data.forks = data.forks.filter((fork) => fork.id !== forkId);
    atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
  });
}

function safeModelOverride(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !REPLAY_MODEL_OVERRIDES.has(value)) {
    throw new Error(`model override must be one of: ${[...REPLAY_MODEL_OVERRIDES].join(', ')}`);
  }
  return value;
}

function readPromptOverride(raw, root) {
  if (raw == null) return { sha256: null };
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) throw new Error('prompt override must be a file path');
  const path = resolve(root, raw);
  const rel = relative(root, path);
  if (rel.startsWith('..') || rel === '' || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error('prompt override must be a regular file inside the worktree');
  }
  const text = readFileSync(path, 'utf8');
  return { sha256: createHash('sha256').update(text).digest('hex') };
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function safeOutputMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { sha256: null, bytes: null };
  return {
    sha256: safeHash(value.sha256 ?? value.output_sha256),
    bytes: Number.isSafeInteger(value.bytes ?? value.output_bytes ?? value.output_length)
      && (value.bytes ?? value.output_bytes ?? value.output_length) >= 0
      ? (value.bytes ?? value.output_bytes ?? value.output_length) : null,
  };
}

function safeTokens(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { input: null, output: null, total: null };
  const input = finiteNonNegative(Number(value.input ?? value.input_tokens ?? value.in));
  const output = finiteNonNegative(Number(value.output ?? value.output_tokens ?? value.out));
  const explicitTotal = finiteNonNegative(Number(value.total ?? value.total_tokens));
  return { input, output, total: explicitTotal ?? (input != null && output != null ? input + output : null) };
}

function safeScore(value) {
  const score = finiteNonNegative(Number(value));
  return score != null && score <= 10 ? score : null;
}

/**
 * Extract only metric metadata.  Trace entries intentionally never store LLM
 * output, so this cannot accidentally turn a replay diff into a secret dump.
 */
function sourceMetrics(span) {
  return {
    output: safeOutputMeta(span.output_meta ?? span),
    tokens: safeTokens(span.tokens_est ?? span.tokens ?? span),
    cost_usd: finiteNonNegative(Number(span.cost_usd ?? span.cost)),
    quality_score: safeScore(span.quality_score),
  };
}

function safeResultFile(raw, root) {
  if (raw == null) return null;
  if (typeof raw !== 'string' || !raw || raw.includes('\0')) throw new Error('replay result must be a file path');
  const path = resolve(root, raw);
  const rel = relative(root, path);
  if (rel.startsWith('..') || rel === '' || !existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error('replay result must be a regular file inside the worktree');
  }
  let data;
  try { data = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('replay result must be valid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('replay result must be a JSON object');
  // Output text is never an accepted replay-result field. The evaluator only
  // needs a hash/length pair; accepting text here would bypass trace redaction.
  if (Object.prototype.hasOwnProperty.call(data, 'output') || Object.prototype.hasOwnProperty.call(data, 'text')) {
    throw new Error('replay result must not contain output text; provide output_sha256 and output_bytes');
  }
  const has = (obj, names) => names.some((name) => Object.prototype.hasOwnProperty.call(obj, name));
  const outputBytes = data.bytes ?? data.output_bytes ?? data.output_length;
  if (has(data, ['output_sha256', 'sha256']) && !safeHash(data.output_sha256 ?? data.sha256)) {
    throw new Error('replay result output_sha256 must be a SHA-256 hex digest');
  }
  if (has(data, ['bytes', 'output_bytes', 'output_length']) && (!Number.isSafeInteger(outputBytes) || outputBytes < 0)) {
    throw new Error('replay result output_bytes must be a non-negative integer');
  }
  const tokens = data.tokens ?? data;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('replay result tokens must be an object');
  for (const names of [['input', 'input_tokens', 'in'], ['output_tokens', 'out', 'output'], ['total', 'total_tokens']]) {
    if (has(tokens, names) && finiteNonNegative(Number(tokens[names.find((name) => Object.prototype.hasOwnProperty.call(tokens, name))])) == null) {
      throw new Error('replay result token counts must be non-negative numbers');
    }
  }
  if (has(data, ['cost_usd', 'cost']) && finiteNonNegative(Number(data.cost_usd ?? data.cost)) == null) {
    throw new Error('replay result cost_usd must be a non-negative number');
  }
  if (Object.prototype.hasOwnProperty.call(data, 'quality_score') && safeScore(data.quality_score) == null) {
    throw new Error('replay result quality_score must be a number from 0 to 10');
  }
  if (Object.prototype.hasOwnProperty.call(data, 'rubric')
    && (typeof data.rubric !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(data.rubric))) {
    throw new Error('replay result rubric must be a safe rubric identifier');
  }
  return {
    output: safeOutputMeta(data),
    tokens: safeTokens(data.tokens ?? data),
    cost_usd: finiteNonNegative(Number(data.cost_usd ?? data.cost)),
    quality_score: safeScore(data.quality_score),
    rubric: data.rubric ?? 'general',
  };
}

function valueDelta(before, after) {
  if (before == null || after == null) return null;
  return after - before;
}

function metricAxis(original, replay) {
  return { original, replay, delta: valueDelta(original, replay) };
}

/** Public four-axis diff; every unavailable value stays explicit and null. */
export function buildReplayDiff(original, replay = null) {
  const replayOutput = replay?.output ?? { sha256: null, bytes: null };
  const originalOutput = original.output ?? { sha256: null, bytes: null };
  const outputState = originalOutput.sha256 && replayOutput.sha256
    ? (originalOutput.sha256 === replayOutput.sha256 ? 'same' : 'changed') : 'unavailable';
  return {
    output: {
      original: originalOutput,
      replay: replayOutput,
      comparison: outputState,
    },
    tokens: {
      input: metricAxis(original.tokens?.input ?? null, replay?.tokens?.input ?? null),
      output: metricAxis(original.tokens?.output ?? null, replay?.tokens?.output ?? null),
      total: metricAxis(original.tokens?.total ?? null, replay?.tokens?.total ?? null),
    },
    cost: metricAxis(original.cost_usd ?? null, replay?.cost_usd ?? null),
    quality: {
      rubric: replay?.rubric ?? 'general',
      score: metricAxis(original.quality_score ?? null, replay?.quality_score ?? null),
      status: replay?.quality_score == null ? 'awaiting_x_eval' : 'recorded',
    },
  };
}

function evalCasePath(root, traceId, spanId, seed) {
  const id = createHash('sha256').update(`${traceId}\0${spanId}\0${seed}`).digest('hex').slice(0, 24);
  return { id: `replay-${id}`, path: join(root, '.xm', 'eval', 'cases', `replay-${id}.json`) };
}

/**
 * Persist a deterministic x-eval input case. link(2) gives create-only
 * atomicity: concurrent identical promotion returns the already-created case
 * rather than replacing it with a torn or different payload.
 */
export function promoteReplayToEval({ root, traceId, spanId, seed, diff, manifestPath }) {
  const target = evalCasePath(root, traceId, spanId, seed);
  mkdirSync(dirname(target.path), { recursive: true });
  if (existsSync(target.path) && lstatSync(target.path).isSymbolicLink()) {
    throw new Error('x-eval case path must not be a symlink');
  }
  const payload = {
    v: 1,
    type: 'replay',
    id: target.id,
    replay_of: { trace_id: traceId, span_id: spanId },
    rubric: diff.quality.rubric,
    // The case points at a manifest and contains metadata only. No trace line,
    // prompt, provider output, or host path is copied into x-eval storage.
    artifact: { manifest_sha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex') },
    axes: diff,
    status: diff.quality.status === 'recorded' ? 'ready' : 'awaiting_result',
    created_at: new Date().toISOString(),
  };
  const tmp = `${target.path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      linkSync(tmp, target.path);
      return { id: target.id, path: target.path, created: true };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      // A competing promotion won. Verify it is a regular JSON case before
      // treating the operation as idempotently successful.
      if (lstatSync(target.path).isSymbolicLink() || !lstatSync(target.path).isFile()) throw new Error('x-eval case path is not a regular file');
      try { JSON.parse(readFileSync(target.path, 'utf8')); }
      catch { throw new Error('existing x-eval case is corrupt'); }
      return { id: target.id, path: target.path, created: false };
    }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

/**
 * Manifest context is intentionally an allowlist, never a serialized trace
 * event. Traces can contain provider messages, tool arguments and private
 * paths; only routing/timing metadata needed to select a deterministic replay
 * is safe to persist here.
 */
function safeContext(span, entries) {
  const allowedLabel = (value) => (
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null
  );
  const compact = (entry) => ({
    type: allowedLabel(entry.type),
    id: allowedLabel(entry.id),
    parent_id: allowedLabel(entry.parent_id),
    role: allowedLabel(entry.role),
    model: allowedLabel(entry.model),
    status: allowedLabel(entry.status),
    duration_ms: Number.isFinite(entry.duration_ms) && entry.duration_ms >= 0 ? entry.duration_ms : null,
  });
  return {
    span: compact(span),
    prior_event_count: entries.indexOf(span),
    prior_types: entries.slice(0, entries.indexOf(span)).map((entry) => allowedLabel(entry.type)).filter(Boolean),
  };
}

/** Build a replay manifest and safe FS archive. Throws on invalid/corrupt input. */
export function createReplay(traceId, spanId, options = {}) {
  safeId(traceId, 'trace id');
  safeId(spanId, 'span id');
  const trace = readTrace(traceId);
  const span = trace.entries.find((entry) => entry.type === 'agent_step' && entry.id === spanId);
  if (!span) throw new Error(`span not found in trace ${traceId}: ${spanId}`);
  const repoRoot = resolveRepoRoot();
  const promptOverride = readPromptOverride(options.promptOverride, repoRoot);
  const replayResult = safeResultFile(options.result, repoRoot);
  const modelOverride = safeModelOverride(options.model);
  const seed = createHash('sha256').update(`${traceId}\0${spanId}\0${trace.raw}`).digest('hex');
  const { root, fork } = reserveFork(traceId, spanId);
  const replayDir = join(root, 'replays', fork.id);
  const archive = join(root, 'fs', `${fork.id}.tar.gz`);
  try {
    const snapshot = makeSnapshot(repoRoot, archive);
    const warnings = snapshot.warnings;
    const originalMetrics = sourceMetrics(span);
    const diff = buildReplayDiff(originalMetrics, replayResult);
    const manifest = {
      v: 1,
      // Never persist an arbitrary correlation_id from a trace: it may contain
      // provider/user data. The validated trace id is the replay linkage.
      replay_of: traceId,
      seed,
      overrides: { model: modelOverride, prompt_override_sha256: promptOverride.sha256 },
      source: { trace_id: traceId, span_id: spanId, trace_sha256: createHash('sha256').update(trace.raw).digest('hex') },
      fork: { id: fork.id, index: fork.index ?? null, max_per_trace: MAX_FORK_POINTS },
      deterministic_context: safeContext(span, trace.entries),
      // Four-axis comparison is metadata-only. In particular, output text is
      // never persisted: hashes and byte counts are sufficient to detect a
      // changed provider result without leaking it into replay artifacts.
      replay_diff: diff,
      snapshot: { archive: relative(resolveTraceDir(), archive), ...snapshot },
      warnings,
      created_at: new Date().toISOString(),
    };
    mkdirSync(replayDir, { recursive: true });
    atomicWrite(join(replayDir, 'replay_manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { manifest, manifestPath: join(replayDir, 'replay_manifest.json'), repoRoot };
  } catch (err) {
    releaseFork(root, traceId, fork.id);
    try { rmSync(replayDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}
