/**
 * x-recall/core — shared utilities for the cross-session artifact index.
 *
 * Read-only over .xm/. No locking needed: recall never mutates artifact
 * files (the one write — HANDOFF.md — is an atomic emit in handoff-md.mjs).
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';

export { readFileSync, existsSync, readdirSync, statSync };
export { join, resolve, extname, basename };

// ── ROOT resolution ─────────────────────────────────────────────────
// recall scans the whole .xm/ tree, so ROOT is .xm itself (not a subdir).

export const XM_ROOT = process.env.X_RECALL_ROOT
  ? resolve(process.env.X_RECALL_ROOT)
  : resolve(process.cwd(), '.xm');

// ── ANSI colors (TTY-aware, NO_COLOR honored) ────────────────────────

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
export const C = isTTY ? {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
} : Object.fromEntries(['reset', 'bold', 'dim', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map(k => [k, '']));

// ── File I/O (read-only, tolerant) ───────────────────────────────────

export function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // missing or corrupt — caller falls back to filename/mtime
  }
}

export function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * List regular files in a directory, optionally filtered by extension.
 * Returns [{ name, path, mtimeMs }]. Missing dir → [].
 */
export function listFiles(dir, exts) {
  if (!existsSync(dir)) return [];
  const out = [];
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue;
    if (exts && !exts.some(e => name.endsWith(e))) continue;
    out.push({ name, path, mtimeMs: st.mtimeMs });
  }
  return out;
}

/** List subdirectories. Returns [{ name, path, mtimeMs }]. Missing dir → []. */
export function listDirs(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isDirectory()) continue;
    out.push({ name, path, mtimeMs: st.mtimeMs });
  }
  return out;
}

// ── Host-suffix deduplication ────────────────────────────────────────
// Multi-device sync writes per-host variants:
//   last-result.json                                         (canonical base)
//   last-result.jinwoo-MeshStudio.local-5135.json            (one host)
//   last-result.HostA.local-6339.HostB.local-5135.json       (merge of two)
// A host token is `.<label>.local-<hash>`, repeated for multi-host merges.
// The `-<hash>` is REQUIRED: without it, a semantic filename ending in
// `.local` (e.g. `release.notes.local.json`) would be wrongly stripped and
// collapsed with unrelated artifacts. Every real sync variant carries the hash.
// We collapse every variant onto the base filename and keep ONE canonical
// entry per base. Without this, the index shows 3–5 duplicates per artifact.

const HOST_SUFFIX_RE = /(\.[A-Za-z0-9-]+\.local-[0-9a-z]+)+$/i;

/** Strip host-suffix tokens from a filename, preserving its extension. */
export function stripHostSuffix(filename) {
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  return stem.replace(HOST_SUFFIX_RE, '') + ext;
}

export function isHostVariant(filename) {
  return stripHostSuffix(filename) !== filename;
}

/**
 * Collapse host variants. Given [{ name, path, mtimeMs }], return one entry
 * per canonical base name: the suffix-free original if present, else the most
 * recently modified variant.
 */
export function dedupeByHost(files) {
  const groups = new Map();
  for (const f of files) {
    const canon = stripHostSuffix(f.name);
    if (!groups.has(canon)) groups.set(canon, []);
    groups.get(canon).push(f);
  }
  const out = [];
  for (const [canon, entries] of groups) {
    const exact = entries.find(e => e.name === canon);
    out.push(exact || entries.slice().sort((a, b) => b.mtimeMs - a.mtimeMs)[0]);
  }
  return out;
}

// ── Time / string helpers ────────────────────────────────────────────

export function toMillis(value) {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

export function isoFromMtime(mtimeMs) {
  return new Date(mtimeMs).toISOString();
}

/** Parse a `--since` value: ISO date (2026-05-01) or relative (7d, 24h). */
export function parseSince(value) {
  if (!value) return 0;
  const rel = String(value).match(/^(\d+)([dh])$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const ms = rel[2] === 'd' ? n * 86400_000 : n * 3600_000;
    return Date.now() - ms;
  }
  return toMillis(value);
}

export function stripExt(name) {
  return name.replace(/\.[^.]+$/, '');
}

/** First markdown H1 (`# ...`) in a file, or null. */
export function firstHeading(path) {
  const text = readText(path);
  if (!text) return null;
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Review verdicts: `pass` is an alias for `lgtm`. Normalize for dedup/filter. */
export function normalizeVerdict(v) {
  if (!v) return '';
  return String(v).toLowerCase() === 'pass' ? 'lgtm' : String(v).toLowerCase();
}
