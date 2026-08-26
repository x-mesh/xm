/**
 * x-trace/drift — time-window drift over what xm already records.
 *
 * "Did latency, error rate, judged quality, review precision, or cost move
 * after the last model / SKILL.md change?" Compares a recent window (default
 * 7d) against the non-overlapping period right before it (default 28d) per
 * (skill, role, model) / (rubric, strategy) / lens key, and flags deltas that
 * cross a threshold — only when BOTH sides have at least `min_samples` rows,
 * so a single slow run cannot raise a flag.
 *
 * Sources (all optional; missing ones are reported as coverage gaps, never as 0):
 *   .xm/traces/*.jsonl            agent_step duration_ms / tokens_est, session_end status
 *   .xm/eval/results/*-score.json overall per (rubric, source_strategy)
 *   .xm/review/triage-ledger.jsonl per-lens precision (x-build review-precision)
 *   .xm/metrics/sessions.jsonl    task_complete cost_usd (always an estimate)
 *
 * Model *version* is not recorded anywhere (the Agent tool returns a label
 * only), so the snapshot carries the x-trace plugin version as its version axis.
 *
 * Thresholds below are candidates: they follow the repo's L9 rule (pick gate
 * values from a simulator, not judgment) only once enough snapshots exist to
 * simulate against — until then the report says so.
 *
 * Zero-dependency: node builtins + trace-writer.mjs (same plugin directory).
 */

import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, realpathSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveXmDir } from './trace-writer.mjs';

export const DEFAULT_WINDOW = '7d';
export const DEFAULT_BASELINE = '28d';
export const DEFAULT_MIN_SAMPLES = 5;
export const AXES = ['latency', 'tokens', 'errors', 'quality', 'precision', 'cost'];
export const MAX_EVAL_SCORE_BYTES = 1024 * 1024;
export const MAX_DRIFT_SNAPSHOT_BYTES = 64 * 1024;
export const MAX_JSONL_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_JSONL_LINE_BYTES = 256 * 1024;
export const MAX_JSONL_ROWS = 100_000;
const SCORE_IDENTIFIER_RE = /^[a-z0-9][a-z0-9._:|-]{0,63}$/;
const GROUP_IDENTIFIER_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const ANSI_ESCAPE_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)?)/g;
const FORMAT_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
/** Candidate thresholds (see header). ratio = relative change, pp = percentage points, abs = absolute. */
export const THRESHOLDS = {
  latency: { kind: 'ratio', direction: 'up', value: 0.25 },
  tokens: { kind: 'ratio', direction: 'up', value: 0.25 },
  cost: { kind: 'ratio', direction: 'up', value: 0.25 },
  errors: { kind: 'pp', direction: 'up', value: 0.10 },
  quality: { kind: 'abs', direction: 'down', value: 0.5 },
  precision: { kind: 'abs', direction: 'down', value: 0.15 },
};
export const THRESHOLD_STATUS = 'candidate — not yet simulator-calibrated (L9); treat flags as prompts to look, not verdicts';

export function parseDuration(value) {
  const match = /^(\d+)\s*([dhm])$/.exec(String(value || '').trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = { d: 86400000, h: 3600000, m: 60000 }[match[2]];
  return n > 0 ? n * unit : null;
}

export function percentile50(values) {
  const v = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function mean(values) {
  const v = (values || []).map(Number).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function round(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/** Tolerant, bounded JSONL reader — unsafe, torn, or malformed input is skipped. */
export function readJsonl(path, {
  maxFileBytes = MAX_JSONL_FILE_BYTES,
  maxLineBytes = MAX_JSONL_LINE_BYTES,
  maxRows = MAX_JSONL_ROWS,
  boundary = null,
} = {}) {
  const rows = [];
  let skipped = 0;
  if (!existsSync(path)) return { rows, skipped };
  if (boundary && !safeReadPath(boundary, path)) return { rows, skipped: 1 };
  let raw;
  try { raw = readBoundedRegularFile(path, maxFileBytes); } catch { raw = null; }
  if (raw == null) return { rows, skipped: 1 };
  let sourceRows = 0;
  for (const line of raw.split('\n')) {
    if (Buffer.byteLength(line, 'utf8') > maxLineBytes) { skipped += 1; continue; }
    const trimmed = line.trim();
    if (!trimmed) continue;
    sourceRows += 1;
    if (sourceRows > maxRows) { skipped += 1; break; }
    try { rows.push(JSON.parse(trimmed)); } catch { skipped += 1; }
  }
  return { rows, skipped };
}

function safeReadPath(boundary, path) {
  const root = resolve(boundary);
  const target = resolve(path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  try {
    const rootInfo = lstatSync(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return false;
    let cursor = root;
    const parentRel = relative(root, dirname(target));
    if (parentRel === '..' || parentRel.startsWith(`..${sep}`) || isAbsolute(parentRel)) return false;
    for (const part of parentRel ? parentRel.split(sep) : []) {
      cursor = join(cursor, part);
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    }
    return true;
  } catch { return false; }
}

/** `{skill}-YYYYMMDD-HHMMSS-{hex}[.host-suffix].jsonl` → { skill, fileTime } */
export function parseTraceFileName(name) {
  const base = name.replace(/\.jsonl$/, '');
  const match = base.match(/^(.*?)-(\d{8})-(\d{6})-[0-9a-f]+(?:\..*)?$/i);
  if (!match) return { skill: 'unknown', fileTime: NaN };
  const [, skill, d, t] = match;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
  return { skill: skill || 'unknown', fileTime: Date.parse(iso) };
}

function timeOf(value, fallback = NaN) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : fallback;
}

// ── collectors ───────────────────────────────────────────────────────

export function collectTraceRows(traceDir, { minTs = -Infinity, maxTs = Infinity } = {}) {
  const steps = [];
  const sessions = [];
  const seenEvents = new Set();
  let files = 0;
  let skipped = 0;
  if (!existsSync(traceDir)) return { steps, sessions, files, skipped };
  try {
    const dir = lstatSync(traceDir);
    if (dir.isSymbolicLink() || !dir.isDirectory()) return { steps, sessions, files, skipped: 1 };
  } catch { return { steps, sessions, files, skipped: 1 }; }
  traceFiles: for (const name of readdirSync(traceDir)) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(traceDir, name);
    try { if (lstatSync(path).isSymbolicLink()) { skipped += 1; continue; } } catch { continue; }
    files += 1;
    const { skill: fileSkill, fileTime } = parseTraceFileName(name);
    const traceMatch = name.replace(/\.jsonl$/, '').match(/^(.*?-\d{8}-\d{6}-[0-9a-f]+)(?:\..*)?$/i);
    const fileSessionId = traceMatch?.[1] || name;
    const parsed = readJsonl(path, { boundary: dirname(traceDir) });
    skipped += parsed.skipped;
    let skill = canonicalIdentifier(fileSkill);
    for (const entry of parsed.rows) {
      if (entry.type === 'session_start' && typeof entry.skill === 'string' && entry.skill) skill = canonicalIdentifier(entry.skill);
    }
    for (const [entryIndex, entry] of parsed.rows.entries()) {
      if (steps.length + sessions.length >= MAX_JSONL_ROWS) { skipped += 1; break traceFiles; }
      const ts = timeOf(entry.ts, fileTime);
      if (!Number.isFinite(ts) || ts < minTs || ts > maxTs) continue;
      const sessionId = typeof entry.session_id === 'string' && entry.session_id
        ? entry.session_id
        : fileSessionId;
      const localEventId = typeof entry.event_id === 'string' && entry.event_id
        ? entry.event_id
        : (typeof entry.id === 'string' && entry.id ? entry.id : `${entry.type}:${entryIndex}`);
      const eventKey = `${sessionId}\u0000${entry.type}\u0000${localEventId}`;
      if (seenEvents.has(eventKey)) continue;
      seenEvents.add(eventKey);
      if (entry.type === 'agent_step') {
        const tokens = entry.tokens_est && typeof entry.tokens_est === 'object'
          ? (Number(entry.tokens_est.input) || 0) + (Number(entry.tokens_est.output) || 0)
          : null;
        steps.push({
          ts, session_id: sessionId, skill, role: canonicalIdentifier(entry.role), model: canonicalIdentifier(entry.model),
          duration_ms: Number.isFinite(Number(entry.duration_ms)) ? Number(entry.duration_ms) : null,
          tokens_total: tokens != null && tokens > 0 ? tokens : null,
          status: entry.status || 'unknown',
        });
      } else if (entry.type === 'session_end') {
        sessions.push({ ts, session_id: sessionId, skill, status: entry.status || 'unknown' });
      }
    }
  }
  return { steps, sessions, files, skipped };
}

export function collectEvalRows(resultsDir) {
  const rows = [];
  let skipped = 0;
  if (!existsSync(resultsDir)) return { rows, skipped };
  let actualResultsDir;
  try {
    const dir = lstatSync(resultsDir);
    if (dir.isSymbolicLink() || !dir.isDirectory()) return { rows, skipped: 1 };
    actualResultsDir = realpathSync(resultsDir);
  } catch { return { rows, skipped: 1 }; }
  for (const name of readdirSync(actualResultsDir)) {
    if (!name.endsWith('-score.json') && !/-score\..*\.json$/.test(name)) continue;
    try {
      const path = join(actualResultsDir, name);
      const raw = readBoundedRegularFile(path, MAX_EVAL_SCORE_BYTES);
      if (raw == null) { skipped += 1; continue; }
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)
        || doc.type !== 'score'
        // Existing score files are unversioned; schema_v:1 is the only versioned form.
        || (Object.hasOwn(doc, 'schema_v') && doc.schema_v !== 1)) { skipped += 1; continue; }
      const overall = doc.overall;
      const ts = timeOf(doc.timestamp);
      const rubric = normalizeScoreIdentifier(doc.rubric, 'unknown');
      const strategy = normalizeScoreIdentifier(doc.source_strategy ?? doc.strategy, 'unknown');
      if (typeof overall !== 'number' || !Number.isFinite(overall) || overall < 0 || overall > 10
        || !Number.isFinite(ts) || rubric == null || strategy == null) { skipped += 1; continue; }
      rows.push({ ts, rubric, strategy, overall, passed: doc.passed === true });
    } catch { skipped += 1; }
  }
  return { rows, skipped };
}

function readBoundedRegularFile(path, maxBytes) {
  if (!Number.isInteger(constants.O_NOFOLLOW) || !Number.isInteger(constants.O_NONBLOCK)) return null;
  let fd;
  try {
    // O_NONBLOCK lets us inspect and reject FIFOs/devices without blocking in
    // open(2) before fstat can prove this is a regular file.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > maxBytes) return null;
    // Read one byte beyond the observed size so concurrent growth still fails
    // closed without allocating the full ceiling for every small source file.
    const buffer = Buffer.allocUnsafe(Math.min(file.size, maxBytes) + 1);
    let bytes = 0;
    while (bytes < buffer.byteLength) {
      const read = readSync(fd, buffer, bytes, buffer.byteLength - bytes, bytes);
      if (read === 0) break;
      bytes += read;
    }
    return bytes <= file.size && bytes <= maxBytes ? buffer.subarray(0, bytes).toString('utf8') : null;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function normalizeScoreIdentifier(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return SCORE_IDENTIFIER_RE.test(normalized) ? normalized : null;
}

function stripFormatterControls(value) {
  return String(value ?? '').replace(ANSI_ESCAPE_RE, '').replace(FORMAT_CONTROL_RE, '');
}

function canonicalIdentifier(value, fallback = 'unknown') {
  if (value == null) return fallback;
  if (typeof value !== 'string') return fallback;
  const normalized = stripFormatterControls(value).trim().toLowerCase();
  return GROUP_IDENTIFIER_RE.test(normalized) ? normalized : fallback;
}

export function collectCostRows(paths, { minTs = -Infinity, maxTs = Infinity, boundary = null } = {}) {
  const rows = [];
  const seenEventIds = new Set();
  let skipped = 0;
  let invalid = 0;
  let duplicates = 0;
  costFiles: for (const path of paths) {
    const parsed = readJsonl(path, { boundary });
    skipped += parsed.skipped;
    for (const entry of parsed.rows) {
      if (rows.length >= MAX_JSONL_ROWS) { skipped += 1; break costFiles; }
      if (entry.type !== 'task_complete') continue;
      const cost = entry.cost_usd;
      const ts = timeOf(entry.timestamp || entry.ts);
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || !Number.isFinite(ts)) {
        invalid += 1;
        continue;
      }
      if (ts < minTs || ts > maxTs) continue;
      if (typeof entry.event_id === 'string' && entry.event_id) {
        if (seenEventIds.has(entry.event_id)) { duplicates += 1; continue; }
        seenEventIds.add(entry.event_id);
      }
      rows.push({
        ts,
        model: canonicalIdentifier(entry.model),
        role: canonicalIdentifier(entry.role),
        strategy: canonicalIdentifier(entry.strategy),
        cost_source: canonicalIdentifier(entry.cost_source, 'legacy'),
        cost_usd: cost,
      });
    }
  }
  return { rows, skipped, invalid, duplicates };
}

export function collectPrecisionRows(ledgerPath, { minTs = -Infinity, maxTs = Infinity, boundary = null } = {}) {
  const parsed = readJsonl(ledgerPath, { boundary });
  const rows = [];
  let limited = false;
  for (const entry of parsed.rows) {
    if (entry.schema_v !== 1 || entry.type !== 'triage_decision') continue;
    const ts = timeOf(entry.ts);
    if (!Number.isFinite(ts) || ts < minTs || ts > maxTs) continue;
    const values = [entry.lens, ...(Array.isArray(entry.lenses) ? entry.lenses : [])];
    const lenses = [...new Set(values.map(value => canonicalIdentifier(value, null)).filter(Boolean))];
    for (const lens of lenses.length > 0 ? lenses : ['unknown']) {
      if (rows.length >= MAX_JSONL_ROWS) { limited = true; break; }
      rows.push({ ts, lens, decision: entry.decision });
    }
    if (limited) break;
  }
  return { rows, skipped: parsed.skipped + Number(limited) };
}

// ── comparison ───────────────────────────────────────────────────────

function crosses(axis, baselineValue, windowValue) {
  const t = THRESHOLDS[axis];
  if (baselineValue == null || windowValue == null) return { flagged: false, delta: null, delta_pct: null };
  const delta = windowValue - baselineValue;
  const deltaPct = baselineValue !== 0 ? delta / Math.abs(baselineValue) : null;
  let flagged = false;
  if (t.kind === 'ratio') {
    if (baselineValue === 0) flagged = t.direction === 'up' ? windowValue > 0 : windowValue < 0;
    else flagged = t.direction === 'up' ? deltaPct >= t.value : deltaPct <= -t.value;
  }
  else if (t.kind === 'pp' || t.kind === 'abs') flagged = t.direction === 'up' ? delta >= t.value : delta <= -t.value;
  return { flagged, delta: round(delta, 4), delta_pct: deltaPct != null ? round(deltaPct, 4) : null };
}

/**
 * Group rows by `keyOf`, split each group into baseline / window by timestamp,
 * and compute `statOf(rows)` on each side. `groupOf` returns the value used for
 * the flag; rows outside both periods are ignored.
 */
export function compareWindows(rows, { axis, now, windowMs, baselineMs, keyOf, statOf, minSamples }) {
  const windowStart = now - windowMs;
  const baselineStart = windowStart - baselineMs;
  const groups = new Map();
  for (const row of rows) {
    if (row.ts > now || row.ts < baselineStart) continue;
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, { baseline: [], window: [] });
    (row.ts >= windowStart ? groups.get(key).window : groups.get(key).baseline).push(row);
  }
  const out = [];
  for (const [key, sides] of groups) {
    const baseline = { n: sides.baseline.length, value: round(statOf(sides.baseline), 4) };
    const window = { n: sides.window.length, value: round(statOf(sides.window), 4) };
    const enough = baseline.n >= minSamples && window.n >= minSamples;
    const { flagged, delta, delta_pct } = enough ? crosses(axis, baseline.value, window.value) : { flagged: false, delta: null, delta_pct: null };
    out.push({ key, baseline, window, delta, delta_pct, flagged, enough_samples: enough });
  }
  return out.sort((a, b) => Number(b.flagged) - Number(a.flagged) || (b.window.n + b.baseline.n) - (a.window.n + a.baseline.n) || a.key.localeCompare(b.key));
}

function errorRate(rows) {
  if (!rows.length) return null;
  return rows.filter(r => ['failed', 'error'].includes(String(r.status).toLowerCase())).length / rows.length;
}

/** Collapse correlated agent_step rows into one independent sample per session/key. */
function sessionMetricRows(steps, field) {
  const groups = new Map();
  for (const step of steps) {
    if (step[field] == null) continue;
    const metricKey = `${step.skill}/${step.role}/${step.model}`;
    const key = `${step.session_id}\u0000${metricKey}`;
    const current = groups.get(key) || { ...step, [field]: 0 };
    current.ts = Math.max(current.ts, step.ts);
    current[field] += step[field];
    groups.set(key, current);
  }
  return [...groups.values()];
}

function precisionOf(rows) {
  const fixNow = rows.filter(r => r.decision === 'fix_now').length;
  const falsePositive = rows.filter(r => r.decision === 'false_positive').length;
  return fixNow + falsePositive > 0 ? fixNow / (fixNow + falsePositive) : null;
}

export function readPluginVersion() {
  try {
    const doc = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    return typeof doc.version === 'string' ? doc.version : null;
  } catch { return null; }
}

/** Build the full report. `now` is an epoch ms (tests pass a fixed one). */
export function driftReport({ xmDir = resolveXmDir(), window = DEFAULT_WINDOW, baseline = DEFAULT_BASELINE, minSamples = DEFAULT_MIN_SAMPLES, axes = AXES, now = Date.now() } = {}) {
  const windowMs = parseDuration(window);
  const baselineMs = parseDuration(baseline);
  if (windowMs == null) throw new Error(`--window must look like 7d, 12h, or 90m (got "${window}")`);
  if (baselineMs == null) throw new Error(`--baseline must look like 28d, 12h, or 90m (got "${baseline}")`);
  if (!Number.isInteger(minSamples) || minSamples <= 0) throw new Error('--min-samples must be a positive integer');
  if (!Array.isArray(axes)) throw new Error('axes must be an array');
  axes = [...new Set(axes.map(axis => typeof axis === 'string' ? axis.trim().toLowerCase() : '').filter(Boolean))];
  if (axes.length === 0) throw new Error(`at least one axis is required (valid: ${AXES.join(', ')})`);
  const unknownAxes = axes.filter(axis => !AXES.includes(axis));
  if (unknownAxes.length) throw new Error(`unknown axis: ${unknownAxes.join(', ')} (valid: ${AXES.join(', ')})`);

  const coverage = [];
  const report = {
    schema_v: 1,
    generated_at: new Date(now).toISOString(),
    window: { spec: window, ms: windowMs, from: new Date(now - windowMs).toISOString(), to: new Date(now).toISOString() },
    baseline: { spec: baseline, ms: baselineMs, from: new Date(now - windowMs - baselineMs).toISOString(), to: new Date(now - windowMs).toISOString() },
    min_samples: minSamples,
    thresholds: THRESHOLDS,
    threshold_status: THRESHOLD_STATUS,
    xm_version: readPluginVersion(),
    axes: {},
    flags: [],
    coverage,
  };
  const common = { now, windowMs, baselineMs, minSamples };
  const sourceWindow = { minTs: now - windowMs - baselineMs, maxTs: now, boundary: xmDir };
  const need = axis => axes.includes(axis);

  let trace = null;
  if (need('latency') || need('tokens') || need('errors')) {
    trace = collectTraceRows(join(xmDir, 'traces'), sourceWindow);
    if (trace.files === 0) coverage.push('traces: no .xm/traces/*.jsonl files — latency, tokens, and errors axes have no data');
    if (trace.skipped > 0) coverage.push(`traces: ${trace.skipped} malformed, oversized, or unsafe JSONL input(s)/line(s) skipped`);
  }
  if (need('latency')) {
    const rows = sessionMetricRows(trace.steps, 'duration_ms');
    report.axes.latency = { unit: 'ms (p50)', rows: compareWindows(rows, { ...common, axis: 'latency', keyOf: r => `${r.skill}/${r.role}/${r.model}`, statOf: rs => percentile50(rs.map(r => r.duration_ms)) }) };
  }
  if (need('tokens')) {
    const rows = sessionMetricRows(trace.steps, 'tokens_total');
    if (trace.steps.length && !rows.length) coverage.push('tokens: agent_step rows carry no tokens_est — axis has no data (estimates are opt-in)');
    report.axes.tokens = { unit: 'tokens_est total (p50, estimate)', rows: compareWindows(rows, { ...common, axis: 'tokens', keyOf: r => `${r.skill}/${r.role}/${r.model}`, statOf: rs => percentile50(rs.map(r => r.tokens_total)) }) };
  }
  if (need('errors')) {
    const known = trace.sessions.filter(r => ['success', 'completed', 'failed', 'error'].includes(String(r.status).toLowerCase()));
    const unknownCount = trace.sessions.length - known.length;
    if (unknownCount) coverage.push(`errors: ${unknownCount} session_end row(s) with unknown status excluded (known: success, completed, failed, error)`);
    report.axes.errors = { unit: 'session_end failed/error rate', rows: compareWindows(known, { ...common, axis: 'errors', keyOf: r => r.skill, statOf: errorRate }) };
  }
  if (need('quality')) {
    const evalRows = collectEvalRows(join(xmDir, 'eval', 'results'));
    if (!evalRows.rows.length) coverage.push('quality: no .xm/eval/results/*-score.json — run /xm:eval score (or x-op --verify) to populate');
    if (evalRows.skipped > 0) coverage.push(`quality: ${evalRows.skipped} invalid, oversized, or symlinked score file(s) skipped`);
    report.axes.quality = { unit: 'judge overall (mean, 1-10)', rows: compareWindows(evalRows.rows, { ...common, axis: 'quality', keyOf: r => `${r.rubric}/${r.strategy}`, statOf: rs => mean(rs.map(r => r.overall)) }) };
  }
  if (need('precision')) {
    const ledger = collectPrecisionRows(join(xmDir, 'review', 'triage-ledger.jsonl'), sourceWindow);
    if (!ledger.rows.length) coverage.push('precision: no .xm/review/triage-ledger.jsonl decisions — x-build verify-review-fix writes them when a triage passes');
    if (ledger.skipped) coverage.push(`precision: ${ledger.skipped} malformed, oversized, or unsafe JSONL input(s)/line(s) skipped`);
    const comparable = ledger.rows.filter(r => r.decision === 'fix_now' || r.decision === 'false_positive');
    report.axes.precision = { unit: 'fix_now / (fix_now + false_positive)', rows: compareWindows(comparable, { ...common, axis: 'precision', keyOf: r => r.lens, statOf: precisionOf }) };
  }
  if (need('cost')) {
    const costPaths = [
      join(xmDir, 'metrics', 'sessions.jsonl'),
      join(xmDir, 'metrics', 'sessions.jsonl.1'),
      join(xmDir, 'build', 'metrics', 'sessions.jsonl'),
      join(xmDir, 'build', 'metrics', 'sessions.jsonl.1'),
    ];
    const cost = collectCostRows(costPaths, sourceWindow);
    if (!cost.rows.length) coverage.push('cost: no task_complete rows in .xm/metrics/sessions.jsonl — axis has no data (all cost figures are estimates when present)');
    if (cost.skipped) coverage.push(`cost: ${cost.skipped} malformed, oversized, or unsafe JSONL input(s)/line(s) skipped`);
    if (cost.invalid) coverage.push(`cost: ${cost.invalid} task_complete row(s) with invalid timestamp or cost that is not a finite non-negative number skipped`);
    if (cost.duplicates) coverage.push(`cost: ${cost.duplicates} duplicate event_id row(s) excluded across active/rotated logs`);
    report.axes.cost = { unit: 'cost_usd (p50, estimate)', rows: compareWindows(cost.rows, { ...common, axis: 'cost', keyOf: r => `${r.model}/${r.role}/${r.cost_source}`, statOf: rs => percentile50(rs.map(r => r.cost_usd)) }) };
  }

  for (const [axis, data] of Object.entries(report.axes)) {
    for (const row of data.rows) {
      if (row.flagged) report.flags.push({ axis, key: row.key, baseline: row.baseline.value, window: row.window.value, delta: row.delta, delta_pct: row.delta_pct, threshold: THRESHOLDS[axis] });
    }
  }
  return report;
}

/** Numeric-only snapshot row for `.xm/metrics/drift.jsonl` (dashboard charting later). */
export function snapshotRow(report) {
  return {
    schema_v: 1,
    type: 'drift_snapshot',
    ts: report.generated_at,
    window: report.window.spec,
    baseline: report.baseline.spec,
    min_samples: report.min_samples,
    xm_version: report.xm_version,
    counts: Object.fromEntries(Object.entries(report.axes).map(([axis, data]) => [axis, { groups: data.rows.length, measured: data.rows.filter(r => r.enough_samples).length, flagged: data.rows.filter(r => r.flagged).length }])),
    flags: report.flags.map(f => ({ axis: f.axis, key: f.key, baseline: f.baseline, window: f.window, delta: f.delta })),
  };
}

export function appendSnapshot(report, xmDir = resolveXmDir()) {
  const root = resolve(xmDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('.xm root must be a regular directory');
  const actualRoot = realpathSync(root);

  const dir = join(root, 'metrics');
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('.xm/metrics must be a regular directory, not a symlink');
  const actualDir = realpathSync(dir);
  if (!isWithin(actualRoot, actualDir)) throw new Error('.xm/metrics escapes the .xm root');

  const path = join(actualDir, 'drift.jsonl');
  if (existsSync(path)) {
    const fileStat = lstatSync(path);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error('.xm/metrics/drift.jsonl must be a regular file, not a symlink');
  }
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error('safe snapshot append requires O_NOFOLLOW support');
  const line = Buffer.from(`${JSON.stringify(snapshotRow(report))}\n`, 'utf8');
  if (line.byteLength > MAX_DRIFT_SNAPSHOT_BYTES) throw new Error(`drift snapshot exceeds ${MAX_DRIFT_SNAPSHOT_BYTES} bytes`);

  let fd;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    if (!fstatSync(fd).isFile()) throw new Error('.xm/metrics/drift.jsonl must be a regular file');
    fchmodSync(fd, 0o600);
    const written = writeSync(fd, line);
    if (written !== line.byteLength) throw new Error(`short drift snapshot append (${written}/${line.byteLength} bytes)`);
  } finally {
    if (fd != null) closeSync(fd);
  }
  return join(dir, 'drift.jsonl');
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function fmt(value, axis) {
  if (value == null) return '—';
  if (axis === 'errors' || axis === 'precision') return `${Math.round(value * 100)}%`;
  if (axis === 'cost') return `$${value}`;
  return String(value);
}

export function formatDriftReport(report) {
  const lines = [];
  lines.push(`📈 [trace] Drift: window ${report.window.spec} (${report.window.from.slice(0, 10)} → ${report.window.to.slice(0, 10)}) vs baseline ${report.baseline.spec} before it · min samples ${report.min_samples}${report.xm_version ? ` · xm ${report.xm_version}` : ''}`);
  lines.push(`Thresholds: ${THRESHOLD_STATUS}`);
  for (const [axis, data] of Object.entries(report.axes)) {
    lines.push('');
    lines.push(`## ${axis} — ${data.unit}`);
    if (!data.rows.length) { lines.push('  (no rows in either period)'); continue; }
    lines.push('| key | baseline (n) | window (n) | Δ | flag |');
    lines.push('|---|---|---|---|---|');
    for (const row of data.rows.slice(0, 40)) {
      const delta = row.delta == null ? '—' : (THRESHOLDS[axis].kind === 'ratio' && row.delta_pct != null ? `${row.delta_pct >= 0 ? '+' : ''}${Math.round(row.delta_pct * 100)}%` : `${row.delta >= 0 ? '+' : ''}${fmt(row.delta, axis)}`);
      const flag = row.flagged ? '⚠ drift' : row.enough_samples ? 'ok' : `n<${report.min_samples}`;
      lines.push(`| ${stripFormatterControls(row.key).replace(/\|/g, '\\|')} | ${fmt(row.baseline.value, axis)} (${row.baseline.n}) | ${fmt(row.window.value, axis)} (${row.window.n}) | ${delta} | ${flag} |`);
    }
    if (data.rows.length > 40) lines.push(`  … ${data.rows.length - 40} more key(s) (use --json)`);
  }
  lines.push('');
  lines.push(report.flags.length ? `⚠ ${report.flags.length} flag(s): ${report.flags.map(f => `${f.axis}:${stripFormatterControls(f.key)}`).join(', ')}` : '✓ no drift flags');
  for (const note of report.coverage) lines.push(`Note: ${note}`);
  lines.push('Note: activity that was never traced or recorded is invisible here — coverage is best-effort.');
  return lines.join('\n');
}
