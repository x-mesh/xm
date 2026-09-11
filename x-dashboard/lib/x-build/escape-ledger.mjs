/** PURE attention-ledger schema, classification, parsing, and aggregation. */
export const ESCAPE_LEDGER_SCHEMA_V = 1;
export const ESCAPE_LEDGER_FILE = 'escape-ledger.jsonl';
export const MAX_ESCAPE_LINE_BYTES = 64 * 1024;

const TYPES = new Set(['escape', 'contested', 'surviving_mutant', 'revived', 'ack']);
const ESCAPE_CLASSES = new Set(['not_reviewed', 'reviewed_missed', 'dismissed_as_fp', 'accepted_risk', 'backlogged']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

function cleanText(value, max = 256) {
  if (typeof value !== 'string') return null;
  const out = value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g, '').replace(CTRL, '').trim();
  return out && out.length <= max ? out : null;
}

export function normalizeAttentionLabel(value) {
  const out = cleanText(value, 128);
  return out && LABEL.test(out) ? out : null;
}

export function normalizeAttentionPath(value) {
  const out = cleanText(value, 1024);
  if (!out || out.startsWith('/') || out.includes('\\')) return null;
  const segments = out.split('/');
  return segments.some(segment => !segment || segment === '.' || segment === '..') ? null : out;
}

function normalizeSeverity(value) {
  const out = normalizeAttentionLabel(value)?.toLowerCase();
  return out && SEVERITIES.has(out) ? out : null;
}

function normalizeEscapeClass(value) {
  const out = normalizeAttentionLabel(value)?.toLowerCase();
  return out && ESCAPE_CLASSES.has(out) ? out : null;
}

function utf8Length(value) {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function hash(value) {
  let n = 2166136261;
  for (const char of String(value)) { n ^= char.charCodeAt(0); n = Math.imul(n, 16777619); }
  return (n >>> 0).toString(36);
}

function findingIdentity(finding) {
  return cleanText(finding?.finding_id || finding?.id, 128);
}

function matchingDecision(finding, ledgerRows) {
  const id = findingIdentity(finding);
  const file = normalizeAttentionPath(finding?.file);
  let match = null;
  for (const row of ledgerRows || []) {
    if (row?.type !== 'triage_decision') continue;
    const sameId = id && findingIdentity(row) === id;
    const sameFile = file && normalizeAttentionPath(row.file) === file;
    if ((id ? !sameId : !sameFile) || (file && !sameFile)) continue;
    match = row;
  }
  return match?.decision || null;
}

/** Classify escape provenance; signal type is deliberately separate. */
export function classifyEscape({ finding = {}, gateRecord = null, ledgerRows = [], escape_class = null } = {}) {
  const explicit = normalizeEscapeClass(escape_class);
  if (explicit) return explicit;
  const decision = matchingDecision(finding, ledgerRows);
  if (decision === 'false_positive') return 'dismissed_as_fp';
  if (decision === 'accept_risk') return 'accepted_risk';
  if (decision === 'backlog') return 'backlogged';
  const file = normalizeAttentionPath(finding.file);
  const reviewedFiles = Array.isArray(gateRecord?.reviewed_files_all) ? gateRecord.reviewed_files_all : (Array.isArray(gateRecord?.reviewed_files) ? gateRecord.reviewed_files : []);
  return file && reviewedFiles.some(candidate => normalizeAttentionPath(candidate) === file) ? 'reviewed_missed' : 'not_reviewed';
}

function signalType(input) {
  if (input?.type === 'ack') return 'ack';
  if (input?.revived || input?.outcome === 'regression' || input?.type === 'revived') return 'revived';
  if (input?.mutant || input?.survived || input?.type === 'surviving_mutant') return 'surviving_mutant';
  if (input?.finding?.kind === 'contested' || input?.kind === 'contested' || input?.type === 'contested') return 'contested';
  return 'escape';
}

export function buildEscapeRow(input = {}) {
  const finding = input.finding || input;
  const type = signalType(input);
  const taskId = normalizeAttentionLabel(input.task_id);
  const artifact = normalizeAttentionPath(input.artifact);
  const relatedFindingId = findingIdentity(finding);
  const stableArtifact = artifact?.replace(/\.attempt-\d+(?=\.json$)/, '') || '';
  const seed = [type, relatedFindingId || '', taskId || '', input.phase || '', stableArtifact, finding.file || '', input.operator || '', input.line || ''].join('|');
  return sanitizeEscapeRow({
    schema_v: ESCAPE_LEDGER_SCHEMA_V, type, id: `ae-${hash(seed)}`, ts: input.ts || new Date(0).toISOString(),
    task_id: taskId, reviewed_commit: input.reviewed_commit,
    escape_class: type === 'escape' ? classifyEscape({ finding, gateRecord: input.gateRecord, ledgerRows: input.ledgerRows, escape_class: input.escape_class }) : null,
    phase: input.phase, panel_run: input.panel_run, artifact, file: finding.file || input.file,
    related_finding_id: relatedFindingId, severity: finding.severity || input.severity, lens: finding.lens || input.lens,
    source: input.source || finding.source || (type === 'surviving_mutant' ? 'mutate' : 'panel'), attribution: input.attribution, escaped_from_task_ids: input.escaped_from_task_ids,
    operator: input.operator, line: input.line,
  });
}

export function sanitizeEscapeRow(input) {
  const type = input?.type;
  const id = cleanText(input?.id, 128);
  if (input?.schema_v !== ESCAPE_LEDGER_SCHEMA_V || !TYPES.has(type) || !id || !ID.test(id)) return null;
  const parsedTs = Date.parse(input.ts || '');
  if (!Number.isFinite(parsedTs)) return null;
  const row = { schema_v: ESCAPE_LEDGER_SCHEMA_V, type, id, ts: new Date(parsedTs).toISOString() };
  for (const key of ['task_id', 'phase', 'panel_run', 'source', 'attribution', 'reviewed_commit', 'related_finding_id', 'operator']) {
    const value = normalizeAttentionLabel(input[key]);
    if (value) row[key] = value;
  }
  if (Array.isArray(input.escaped_from_task_ids)) {
    const ids = [...new Set(input.escaped_from_task_ids.map(value => normalizeAttentionLabel(value)).filter(Boolean))].sort();
    if (ids.length) row.escaped_from_task_ids = ids;
  }
  const severity = normalizeSeverity(input.severity);
  if (severity) row.severity = severity;
  const lens = normalizeAttentionLabel(input.lens);
  if (lens) row.lens = lens;
  const file = normalizeAttentionPath(input.file);
  if (file) row.file = file;
  const artifact = normalizeAttentionPath(input.artifact);
  if (artifact) row.artifact = artifact;
  if (type === 'escape') row.escape_class = normalizeEscapeClass(input.escape_class) || 'not_reviewed';
  if (Number.isInteger(input.line) && input.line > 0) row.line = input.line;
  if (type === 'ack') {
    const note = cleanText(input.note, 256);
    if (note) row.note = note;
  }
  return row;
}

export function escapeRowKey(row) {
  if (row?.type === 'ack') return `ack|${row.id || ''}`;
  return `${row?.type || ''}|${row?.id || ''}|${row?.reviewed_commit || ''}|${row?.operator || ''}|${row?.line || ''}`;
}

export function parseEscapeLedger(text, { maxLines = 100000 } = {}) {
  const rows = [];
  let parseErrors = 0;
  let count = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    count += 1;
    if (count > maxLines || utf8Length(line) > MAX_ESCAPE_LINE_BYTES) { parseErrors += 1; continue; }
    try { const row = sanitizeEscapeRow(JSON.parse(line)); if (row) rows.push(row); else parseErrors += 1; } catch { parseErrors += 1; }
  }
  return { rows, skipped: parseErrors, parse_errors: parseErrors };
}

export function aggregateEscapeRows(rows) {
  const items = new Map();
  const acked = new Set();
  for (const input of rows || []) {
    const row = sanitizeEscapeRow(input);
    if (!row) continue;
    if (row.type === 'ack') { acked.add(row.id); continue; }
    const key = escapeRowKey(row);
    const prior = items.get(key);
    if (!prior || row.ts > prior.ts) items.set(key, row);
  }
  return { rows: [...items.values()], acked };
}

export function aggregateEscapeClass(rows, { since = null, now = Date.now() } = {}) {
  const aggregate = aggregateEscapeRows(rows);
  const byClass = Object.fromEntries([...ESCAPE_CLASSES].map(name => [name, 0]));
  const byLens = {};
  const bySeverity = {};
  const cutoff = typeof since === 'number' && since >= 0 ? now - since : null;
  const kept = cutoff == null ? aggregate.rows : aggregate.rows.filter(row => Date.parse(row.ts) >= cutoff);
  for (const row of kept) {
    if (row.type === 'escape') byClass[row.escape_class] += 1;
    if (row.lens) byLens[row.lens] = (byLens[row.lens] || 0) + 1;
    if (row.severity) bySeverity[row.severity] = (bySeverity[row.severity] || 0) + 1;
  }
  return { by_class: byClass, by_lens: byLens, by_severity: bySeverity, total: kept.length, rows: kept, acked: aggregate.acked };
}
