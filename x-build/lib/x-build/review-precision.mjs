/**
 * x-build/review-precision — triage-ledger parsing and per-lens precision.
 *
 * The Review-Fix Gate forces a decision (fix_now / backlog / accept_risk /
 * false_positive) on every Medium+ finding, but until now that decision lived
 * only in the latest `.xm/review/triage.json`. `verify-review-fix` appends each
 * passing decision (and each reverification outcome) to
 * `.xm/review/triage-ledger.jsonl` so the question "which lens produces false
 * positives?" has data behind it.
 *
 * This module is PURE — no filesystem, no config, no imports — so the x-build
 * CLI and the dashboard (which lives in a different plugin directory and must
 * not import x-build's core) can share the same aggregation. Callers read the
 * ledger file themselves and pass the text in.
 *
 * Ledger rows carry counts, ids, hashes, and a repo-relative file path only —
 * never finding summaries or evidence text (metrics privacy rule).
 */

export const TRIAGE_LEDGER_SCHEMA_V = 1;
export const TRIAGE_LEDGER_FILE = 'triage-ledger.jsonl';
export const TRIAGE_DECISIONS = ['fix_now', 'backlog', 'accept_risk', 'false_positive'];
export const REVERIFY_OUTCOMES = ['resolved', 'persistent', 'regression'];
const ROW_TYPES = new Set(['triage_decision', 'triage_outcome']);

/** Lens attribution for a finding; x-review sometimes emits `lenses[]`. */
export function findingLens(finding) {
  const lens = finding?.lens
    || (Array.isArray(finding?.lenses) ? finding.lenses[0] : null)
    || (Array.isArray(finding?.sources) ? finding.sources[0] : null);
  return typeof lens === 'string' && lens.trim() ? lens.trim().toLowerCase() : 'unknown';
}

/** Build one ledger row. `decision` xor `outcome` decides the row type. */
export function buildLedgerRow({ ts, reviewed_commit, finding, decision, outcome, triage_digest }) {
  const base = {
    schema_v: TRIAGE_LEDGER_SCHEMA_V,
    ts,
    reviewed_commit: reviewed_commit || null,
    finding_id: finding.finding_id,
    id: finding.id,
    lens: findingLens(finding),
    severity: String(finding.severity || '').toLowerCase() || 'unknown',
    file: finding.file || null,
    triage_digest: triage_digest || null,
  };
  if (outcome) return { ...base, type: 'triage_outcome', outcome };
  return { ...base, type: 'triage_decision', decision };
}

/** Identity used to keep re-runs of the gate from double-counting. */
export function ledgerRowKey(row) {
  const value = row.type === 'triage_outcome' ? row.outcome : row.decision;
  return `${row.type}|${row.reviewed_commit || ''}|${row.finding_id || ''}|${value || ''}`;
}

function isValidRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.schema_v !== TRIAGE_LEDGER_SCHEMA_V || !ROW_TYPES.has(row.type)) return false;
  if (typeof row.finding_id !== 'string' || !row.finding_id) return false;
  if (row.type === 'triage_decision') return TRIAGE_DECISIONS.includes(row.decision);
  return REVERIFY_OUTCOMES.includes(row.outcome);
}

/**
 * Parse ledger text. Torn or malformed lines are skipped (an append-only JSONL
 * file can end mid-line while another process writes), counted in `skipped`.
 */
export function parseTriageLedger(text) {
  const rows = [];
  let skipped = 0;
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); } catch { skipped += 1; continue; }
    if (!isValidRow(row)) { skipped += 1; continue; }
    rows.push(row);
  }
  return { rows, skipped };
}

/** `30d` / `12h` / `90m` → milliseconds; anything else → null. */
export function parseDuration(value) {
  const match = /^(\d+)\s*([dhm])$/.exec(String(value || '').trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = { d: 86400000, h: 3600000, m: 60000 }[match[2]];
  return n > 0 ? n * unit : null;
}

function timeOf(row) {
  const t = Date.parse(row.ts || '');
  return Number.isFinite(t) ? t : null;
}

/**
 * Restrict rows to a window. `since` is a duration string ('30d') or ms;
 * `last` keeps the N most recently seen reviewed_commits; `lens` keeps one lens.
 * Rows are de-duplicated by ledgerRowKey first so repeated gate runs count once.
 */
export function filterLedgerRows(rows, { since = null, last = null, lens = null, now = Date.now() } = {}) {
  const seen = new Set();
  let kept = [];
  for (const row of rows) {
    const key = ledgerRowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(row);
  }
  if (lens) kept = kept.filter(row => row.lens === String(lens).toLowerCase());
  if (since != null) {
    const windowMs = typeof since === 'number' ? since : parseDuration(since);
    if (windowMs != null) {
      const cutoff = now - windowMs;
      kept = kept.filter(row => { const t = timeOf(row); return t != null && t >= cutoff; });
    }
  }
  if (last != null && Number(last) > 0) {
    const order = [];
    const firstSeen = new Map();
    for (const row of kept) {
      const commit = row.reviewed_commit || '';
      const t = timeOf(row) ?? 0;
      if (!firstSeen.has(commit) || t > firstSeen.get(commit)) firstSeen.set(commit, t);
      if (!order.includes(commit)) order.push(commit);
    }
    const recent = [...firstSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(last)).map(([commit]) => commit);
    const allowed = new Set(recent);
    kept = kept.filter(row => allowed.has(row.reviewed_commit || ''));
  }
  return kept;
}

function emptyBucket(name, keyName) {
  return {
    [keyName]: name,
    decided: 0, fix_now: 0, backlog: 0, accept_risk: 0, false_positive: 0,
    precision: null,
    resolved: 0, persistent: 0, regression: 0,
  };
}

function finishBucket(bucket) {
  const denominator = bucket.fix_now + bucket.false_positive;
  bucket.precision = denominator > 0 ? Number((bucket.fix_now / denominator).toFixed(3)) : null;
  return bucket;
}

/**
 * Per-lens and per-severity precision.
 * precision = fix_now / (fix_now + false_positive); null when that denominator
 * is 0 — a lens with no fix_now and no false_positive has not been measured.
 * backlog / accept_risk are reported but excluded from precision: they say the
 * finding was real but not worth fixing now, not that the lens was wrong.
 */
export function aggregateLensPrecision(rows, options = {}) {
  const filtered = filterLedgerRows(rows, options);
  const lenses = new Map();
  const severities = new Map();
  const totals = finishBucket(emptyBucket('all', 'scope'));
  const commits = new Set();
  let from = null;
  let to = null;

  const bucketFor = (map, name, keyName) => {
    if (!map.has(name)) map.set(name, emptyBucket(name, keyName));
    return map.get(name);
  };
  const apply = (bucket, row) => {
    if (row.type === 'triage_decision') {
      bucket.decided += 1;
      bucket[row.decision] += 1;
    } else {
      bucket[row.outcome] += 1;
    }
  };

  for (const row of filtered) {
    commits.add(row.reviewed_commit || '');
    const t = timeOf(row);
    if (t != null) {
      if (from == null || t < from) from = t;
      if (to == null || t > to) to = t;
    }
    apply(bucketFor(lenses, row.lens || 'unknown', 'lens'), row);
    apply(bucketFor(severities, row.severity || 'unknown', 'severity'), row);
    apply(totals, row);
  }

  const byDecidedDesc = (a, b) => b.decided - a.decided || String(a.lens || a.severity).localeCompare(String(b.lens || b.severity));
  return {
    schema_v: TRIAGE_LEDGER_SCHEMA_V,
    window: {
      since: options.since ?? null,
      last: options.last ?? null,
      lens: options.lens ?? null,
      from: from != null ? new Date(from).toISOString() : null,
      to: to != null ? new Date(to).toISOString() : null,
      reviews: commits.size,
      rows: filtered.length,
    },
    lenses: [...lenses.values()].map(finishBucket).sort(byDecidedDesc),
    severities: [...severities.values()].map(finishBucket).sort(byDecidedDesc),
    totals: finishBucket(totals),
  };
}

/** Lenses whose measured precision falls below `min` (unmeasured lenses are skipped). */
export function lensesBelowPrecision(report, min) {
  const threshold = Number(min);
  if (!Number.isFinite(threshold)) return [];
  return report.lenses.filter(bucket => bucket.precision != null && bucket.precision < threshold);
}

function pad(value, width, right = false) {
  const text = String(value ?? '');
  return right ? text.padStart(width) : text.padEnd(width);
}

function precisionText(bucket) {
  return bucket.precision == null ? '—' : `${Math.round(bucket.precision * 100)}%`;
}

/** Plain-text table for the CLI. */
export function formatPrecisionReport(report) {
  const lines = [];
  const { window } = report;
  const scope = [
    window.since ? `since ${window.since}` : null,
    window.last ? `last ${window.last} review(s)` : null,
    window.lens ? `lens ${window.lens}` : null,
  ].filter(Boolean).join(', ') || 'all rows';
  lines.push(`Window: ${scope} · reviews: ${window.reviews} · rows: ${window.rows}${window.from ? ` · ${window.from.slice(0, 10)} → ${window.to.slice(0, 10)}` : ''}`);
  const header = `${pad('lens', 16)}${pad('decided', 8, true)}${pad('fix_now', 8, true)}${pad('backlog', 8, true)}${pad('accept', 8, true)}${pad('false+', 8, true)}${pad('precision', 10, true)}${pad('resolved', 9, true)}${pad('persist', 8, true)}${pad('regress', 8, true)}`;
  lines.push(header);
  for (const bucket of report.lenses) {
    lines.push(`${pad(bucket.lens, 16)}${pad(bucket.decided, 8, true)}${pad(bucket.fix_now, 8, true)}${pad(bucket.backlog, 8, true)}${pad(bucket.accept_risk, 8, true)}${pad(bucket.false_positive, 8, true)}${pad(precisionText(bucket), 10, true)}${pad(bucket.resolved, 9, true)}${pad(bucket.persistent, 8, true)}${pad(bucket.regression, 8, true)}`);
  }
  lines.push(`${pad('total', 16)}${pad(report.totals.decided, 8, true)}${pad(report.totals.fix_now, 8, true)}${pad(report.totals.backlog, 8, true)}${pad(report.totals.accept_risk, 8, true)}${pad(report.totals.false_positive, 8, true)}${pad(precisionText(report.totals), 10, true)}${pad(report.totals.resolved, 9, true)}${pad(report.totals.persistent, 8, true)}${pad(report.totals.regression, 8, true)}`);
  if (report.severities.length) {
    lines.push('');
    lines.push(`${pad('severity', 16)}${pad('decided', 8, true)}${pad('fix_now', 8, true)}${pad('false+', 8, true)}${pad('precision', 10, true)}`);
    for (const bucket of report.severities) {
      lines.push(`${pad(bucket.severity, 16)}${pad(bucket.decided, 8, true)}${pad(bucket.fix_now, 8, true)}${pad(bucket.false_positive, 8, true)}${pad(precisionText(bucket), 10, true)}`);
    }
  }
  lines.push('');
  lines.push('precision = fix_now / (fix_now + false_positive); "—" = not measured (no fix_now or false_positive yet).');
  return lines.join('\n');
}
