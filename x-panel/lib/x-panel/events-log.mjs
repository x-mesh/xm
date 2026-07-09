/**
 * x-panel/events-log — read & format the durable per-run event log (events.jsonl).
 *
 * events.jsonl is the MILESTONE-only, append-only record written by x-panel-cli's
 * writeEvent (spawn/stdout/stderr/exit/json_parsed/json_missing/usage_final/…). This
 * leaf is the ONE canonical reader + terminal formatter, shared by the CLI
 * (`xm panel status <run> --logs`) and any future consumer, so the schema is decoded
 * in exactly one place. The web dashboard has its own HTML renderer but the SAME
 * record shape (x-dashboard readPanelEvents / panelEventRows).
 *
 * Zero-import leaf beyond node builtins (same rule as adapters.mjs / tm-events.mjs).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ANSI inlined (not imported from core) so this stays a pure leaf. color:false —
// NO_COLOR, a non-TTY pipe, or tests — yields plain text via the empty palette.
const ANSI = Object.freeze({
  reset: '\x1b[0m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m',
});
const PLAIN = Object.freeze(Object.fromEntries(Object.keys(ANSI).map((k) => [k, ''])));

// type → {sym, key}. Covers EVERY milestone writeEvent can emit — spawn/stdout/stderr/
// json_parsed/json_missing/usage_final/lifecycle/timeout/error/run_done — plus exit &
// model_done (whose color depends on ok/code). An unknown/new type falls back to a
// neutral dot so a future event never renders blank (panel-review finding, addressed).
const GLYPH = Object.freeze({
  run_start: { sym: '▸', key: 'blue' },
  round_start: { sym: '▸', key: 'blue' },
  spawn: { sym: '▸', key: 'blue' },
  stdout: { sym: '│', key: 'green' },
  stderr: { sym: '│', key: 'yellow' },
  json_parsed: { sym: '✓', key: 'green' },
  json_missing: { sym: '⚠', key: 'red' },
  usage_final: { sym: '$', key: 'cyan' },
  lifecycle: { sym: '·', key: 'dim' },
  timeout: { sym: '⏱', key: 'red' },
  error: { sym: '✗', key: 'red' },
  run_done: { sym: '✓', key: 'green' },
});

// exit / model_done / round_file_written carry an ok (or exit code) — color by outcome.
const OK_KEYED = new Set(['exit', 'model_done', 'round_file_written']);

function glyphFor(rec) {
  const t = String(rec.type || '');
  if (OK_KEYED.has(t)) {
    const ok = rec.ok != null ? rec.ok : (rec.code === 0 || rec.code == null);
    return ok ? { sym: '✓', key: 'green' } : { sym: '✗', key: 'red' };
  }
  return GLYPH[t] || { sym: '·', key: 'dim' };
}

// Strip terminal control sequences from event text before printing. The text is model
// stdout/stderr — redactPanelText scrubbed secrets at write time, but redaction does NOT
// target ANSI/control bytes; an unsanitized escape (CSI/OSC) could hijack the reader's
// terminal (panel-review finding, addressed). Keep \t and \n; drop the rest of C0 + DEL.
export function sanitizeEventText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC … BEL/ST
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')         // CSI … final byte
    .replace(/\x1b[@-Z\\-_]/g, '')                     // other 2-byte ESC sequences
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');         // stray C0 controls + DEL (leftover ESC too)
}

function fmtTime(at) {
  if (!at) return '--:--:--';
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? d.toTimeString().slice(0, 8) : '--:--:--';
}

/**
 * Read parsed records from a run's events.jsonl.
 *
 * @param {string} runDir  the run directory (…/.xm/{panel|review}/<run>)
 * @param {object} [opts]
 * @param {number} [opts.limit=120]   INITIAL view: return the last N records (0 = none).
 * @param {number|null} [opts.sinceSeq=null]  FOLLOW view: return EVERY record with seq >
 *   sinceSeq. When set, `limit` is IGNORED — capping a follow read would permanently drop
 *   a burst of >limit new records once the caller advances its lastSeq past them
 *   (panel-review finding, addressed). events.jsonl is milestone-only, so an uncapped
 *   since-read stays bounded.
 * @param {string[]|null} [opts.types=null]  keep only these record types.
 * @returns {object[]} parsed records in file order (oldest first). [] if unreadable.
 */
export function readEventsLog(runDir, { limit = 120, sinceSeq = null, types = null } = {}) {
  let raw;
  try {
    raw = readFileSync(join(runDir, 'events.jsonl'), 'utf8');
  } catch {
    return []; // no log yet (run just started) or unreadable — caller shows a waiting/empty note
  }
  const recs = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // skip a partial/corrupt trailing line
    if (types && !types.includes(o.type)) continue;
    recs.push(o);
  }
  if (sinceSeq != null) return recs.filter((r) => (r.seq || 0) > sinceSeq);
  return limit > 0 ? recs.slice(-limit) : [];
}

/** Highest seq in a record list (for a follow loop's lastSeq), or `floor` if empty. */
export function maxSeq(recs, floor = 0) {
  let m = floor;
  for (const r of recs || []) if ((r.seq || 0) > m) m = r.seq;
  return m;
}

/**
 * Format one event record as terminal text: a header line (time · glyph · model · type ·
 * meta) plus, when the record carries `text`, its (sanitized) body indented under a gutter.
 * Multi-line text keeps its line breaks. Returns a string that may contain '\n'.
 *
 * @param {object} rec
 * @param {object} [opts]
 * @param {boolean} [opts.color=true]  false → plain (NO_COLOR / pipe / tests)
 * @param {number} [opts.width=0]      >0 → clip each body line to this terminal width
 */
export function formatEventLine(rec, { color = true, width = 0 } = {}) {
  const c = color ? ANSI : PLAIN;
  const g = glyphFor(rec);
  const meta = [
    rec.model || '',
    String(rec.type || 'event'),
    rec.bytes ? `${rec.bytes}b` : '',
    rec.code != null ? `exit ${rec.code}` : '',
    rec.error ? `err ${sanitizeEventText(String(rec.error)).slice(0, 100)}` : '',
    rec.truncated ? 'truncated' : '',
  ].filter(Boolean).join(' · ');
  const head = `${c.dim}${fmtTime(rec.at)}${c.reset} ${c[g.key]}${g.sym}${c.reset} ${c.dim}${meta}${c.reset}`;
  const text = sanitizeEventText(rec.text);
  if (!text) return head;
  const cap = width > 0 ? Math.max(8, width - 6) : 0;
  const body = text.split('\n').map((ln) => {
    const clipped = cap && ln.length > cap ? `${ln.slice(0, cap - 1)}…` : ln;
    return `    ${c.dim}│${c.reset} ${clipped}`;
  }).join('\n');
  return `${head}\n${body}`;
}
