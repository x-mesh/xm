#!/usr/bin/env bun
/**
 * x-dashboard-server.mjs — Bun HTTP server for xm-dashboard
 *
 * Architecture: Bun HTTP server → serves static files from public/ + JSON API
 * Pattern: follows xm-server.mjs for PID file management and shutdown
 *
 * Usage: bun x-dashboard-server.mjs [--port N] [--session] [--scan <dir>]
 *
 * Mode A (default):  standalone, no idle timeout
 * Mode B (--session): 60 min idle timeout
 * Mode C (--scan <dir>): multi-root workspace mode
 */

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, readFileSync, statSync, renameSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

// ── Config ──────────────────────────────────────────────────────────

const DEFAULT_PORT = 19841;
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const VERSION = process.env.XM_SYNC_VERSION ?? '0.1.0';

const args = process.argv.slice(2);
const STOP_MODE = args.includes('--stop');
const BUILD_ID_MODE = args.includes('--print-build-id') || args.includes('--build-id');
const PORT = parseInt(getArg('--port') ?? String(DEFAULT_PORT), 10);
const SESSION_MODE = args.includes('--session');
const SCAN_DIR = getArg('--scan');
const RUN_DIR = join(homedir(), '.xm', 'run');
const PID_FILE = join(RUN_DIR, 'xdashboard-server.pid');
const SERVER_DIR = resolve(dirname(new URL(import.meta.url).pathname));
const PUBLIC_DIR = resolve(SERVER_DIR, '..', 'public');

const XM_ROOT = resolveProjectXm();

/** Resolve .xm/ — prefer local, fallback to main repo for worktrees */
function resolveProjectXm() {
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

const startedAt = Date.now();

// ── safeJoin ────────────────────────────────────────────────────────

/**
 * Safely join path segments under a base directory.
 * Returns null if the resolved path escapes the base (path traversal).
 *
 * @param {string} base - Absolute base directory
 * @param {...string} segments - Path segments to join
 * @returns {string|null} Resolved path or null if traversal detected
 */
function safeJoin(base, ...segments) {
  const resolvedBase = resolve(base);
  // Reject any segment containing percent-encoded traversal sequences
  for (const seg of segments) {
    if (/%2e/i.test(seg) || /%2f/i.test(seg)) return null;
  }
  const resolvedTarget = resolve(base, ...segments);
  if (!resolvedTarget.startsWith(resolvedBase + '/') && resolvedTarget !== resolvedBase) {
    return null;
  }
  return resolvedTarget;
}

// ── Segment Validation ──────────────────────────────────────────────

const SAFE_SEGMENT_RE = /^[^./\\]+$/;

function isValidSegment(segment) {
  return SAFE_SEGMENT_RE.test(segment);
}

// ── ETag Helpers ────────────────────────────────────────────────────

function hashSimple(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0; // keep unsigned 32-bit
  }
  return h.toString(36);
}

function jsonResponseWithETag(data, req, status = 200) {
  const body = JSON.stringify(data);
  const etag = `"${body.length.toString(36)}-${hashSimple(body)}"`;
  if (req && req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { 'ETag': etag, 'Cache-Control': 'no-cache' } });
  }
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'ETag': etag,
      'Cache-Control': 'no-cache',
    },
  });
}

// ── Idle Timer (Session Mode only) ──────────────────────────────────

let idleTimer = null;
let lastActivity = Date.now();

function resetIdleTimer() {
  lastActivity = Date.now();
  if (!SESSION_MODE) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log(`[x-dashboard-server] Idle for ${SESSION_IDLE_TIMEOUT_MS / 1000}s, shutting down.`);
    shutdown();
  }, SESSION_IDLE_TIMEOUT_MS);
}

// ── MIME Types ──────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
};

function getMime(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

// ── Static File Serving ──────────────────────────────────────────────

async function serveStatic(urlPath) {
  // Normalize: / -> /index.html
  const normalizedPath = urlPath === '/' ? '/index.html' : urlPath;

  // Split and validate each segment
  const segments = normalizedPath.split('/').filter(Boolean);
  for (const seg of segments) {
    // Allow file extensions: validate base name only
    const base = seg.includes('.') ? seg.slice(0, seg.lastIndexOf('.')) : seg;
    if (base && !isValidSegment(base)) {
      return new Response('Forbidden', { status: 403 });
    }
  }

  const filePath = safeJoin(PUBLIC_DIR, ...segments);
  if (!filePath) {
    return new Response('Forbidden', { status: 403 });
  }

  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) {
    return new Response('Not found', { status: 404 });
  }

  // no-cache tells browsers to revalidate every request. Combined with
  // our JSON API's ETag handling, unchanged assets return 304 quickly,
  // but the browser never serves a stale cached copy after we ship a
  // fix (solves the common "hard-reload didn't pick up new JS" issue).
  return new Response(file, {
    headers: {
      'Content-Type': getMime(filePath),
      'Cache-Control': 'no-cache, must-revalidate',
    },
  });
}

// ── M1: WorkspaceScanner ─────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

/**
 * Recursively scan rootDir for directories containing .xm/
 * @param {string} rootDir - Absolute path to scan
 * @param {number} maxDepth - Maximum recursion depth (default 4)
 * @returns {Array<{id: string, name: string, path: string, xmRoot: string}>}
 */
/** Check if dir is a git worktree (.git is a file, not a directory) */
function isGitWorktree(dir) {
  try {
    const st = statSync(join(dir, '.git'));
    return st.isFile();
  } catch {
    return false;
  }
}

/** For a worktree dir, resolve the main repo's .xm/ path (or null) */
function getMainRepoXm(dir) {
  try {
    const content = readFileSync(join(dir, '.git'), 'utf8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return null;
    const gitdir = resolve(dir, match[1]);

    // Strategy 1: gitdir path exists — walk up 3 levels from .git/worktrees/<name>
    const mainRoot1 = resolve(gitdir, '..', '..', '..');
    const mainXm1 = join(mainRoot1, '.xm');
    if (existsSync(mainXm1)) return mainXm1;

    // Strategy 2: gitdir path is stale (repo renamed) — read commondir from
    // the actual worktree entry inside the real repo's .git/worktrees/<name>/
    // The gitdir pattern is always .../.git/worktrees/<name>, so extract
    // the worktree name and search for it in sibling repos
    const wtMatch = gitdir.match(/(.+)\/\.git\/worktrees\/([^/]+)$/);
    if (wtMatch) {
      const wtName = wtMatch[2];
      // Scan parent dir for a repo that owns this worktree
      const parentDir = dirname(dir);
      try {
        for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidate = join(parentDir, entry.name, '.git', 'worktrees', wtName);
          if (existsSync(candidate)) {
            const mainXm2 = join(parentDir, entry.name, '.xm');
            if (existsSync(mainXm2)) return mainXm2;
          }
        }
      } catch {}
    }

    return null;
  } catch {
    return null;
  }
}

function scanWorkspaces(rootDir, maxDepth = 4) {
  const results = [];
  const usedIds = new Set();

  /** Stable, collision-free id for a workspace dir (handles nested duplicate basenames). */
  function makeId(fullPath) {
    let id = basename(fullPath);
    if (usedIds.has(id)) {
      id = `${basename(dirname(fullPath))}/${basename(fullPath)}`;
      let n = 2;
      while (usedIds.has(id)) id = `${basename(dirname(fullPath))}/${basename(fullPath)}-${n++}`;
    }
    usedIds.add(id);
    return id;
  }

  function register(fullPath, parentId) {
    const id = makeId(fullPath);
    results.push({
      id,
      name: basename(fullPath),
      path: fullPath,
      xmRoot: join(fullPath, '.xm'),
      parentId: parentId ?? null,
    });
    return id;
  }

  function scan(dir, depth, parentId) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const xmPath = join(fullPath, '.xm');
      if (existsSync(xmPath)) {
        try {
          const stat = statSync(xmPath);
          if (stat.isDirectory()) {
            // Skip worktrees whose main repo has its own .xm/
            if (isGitWorktree(fullPath) && getMainRepoXm(fullPath)) {
              continue;
            }
            const id = register(fullPath, parentId);
            // Recurse INTO this workspace too — surfaces nested workspaces
            // (e.g. independent repos living inside a container workspace).
            scan(fullPath, depth + 1, id);
            continue;
          }
        } catch {
          // stat failed, skip
        }
      }
      scan(fullPath, depth + 1, parentId);
    }
  }

  // Also check rootDir itself
  const rootXm = join(rootDir, '.xm');
  if (existsSync(rootXm)) {
    try {
      const stat = statSync(rootXm);
      if (stat.isDirectory()) {
        // Skip if rootDir itself is a worktree with main repo .xm/
        if (isGitWorktree(rootDir) && getMainRepoXm(rootDir)) {
          scan(rootDir, 1, null);
        } else {
          const id = register(rootDir, null);
          scan(rootDir, 1, id);
        }
      }
    } catch {}
  } else {
    scan(rootDir, 1, null);
  }

  return results;
}

// ── M2: WorkspaceRegistry ────────────────────────────────────────────

let workspaces = [];

function getWorkspace(wsId) {
  return workspaces.find(w => w.id === wsId);
}

function getAllWorkspaces() {
  return workspaces;
}

// ── M3: ScopedAPI helpers ────────────────────────────────────────────

function resolveXmRoot(wsId) {
  const ws = getWorkspace(wsId);
  return ws ? ws.xmRoot : null;
}

// ── x-recall engine (lazy, cache-safe) ───────────────────────────────
// Reuse x-recall's scanner instead of re-implementing artifact enumeration
// (and its host-variant dedup). scan.mjs has no side effects, so a dynamic
// import is safe; resolve across the xm bundle (sibling x-recall/) and the
// standalone source tree. Falls back to no-ops when x-recall isn't installed.
let _recallEngine = null;
async function getRecallEngine() {
  if (_recallEngine) return _recallEngine;
  const here = import.meta.dirname;
  const candidates = [
    join(here, 'x-recall', 'scan.mjs'),                                // xm bundle: xm/lib/x-recall/scan.mjs
    join(here, '..', '..', 'x-recall', 'lib', 'x-recall', 'scan.mjs'), // source: x-dashboard/lib → x-recall/lib/x-recall/scan.mjs
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { _recallEngine = await import(p); return _recallEngine; } catch { /* try next */ }
    }
  }
  _recallEngine = { scanAll: () => [], search: () => [] };
  return _recallEngine;
}

async function handleRecallList(xmRoot, req) {
  const { scanAll, search } = await getRecallEngine();
  const url = new URL(req.url);
  const type = url.searchParams.get('type') || undefined;
  const q = url.searchParams.get('q') || undefined;
  const since = url.searchParams.get('since') || undefined;
  const items = q ? search(xmRoot, q, { type, since }) : scanAll(xmRoot, { type, since });
  return jsonResponseWithETag({ items, total: items.length }, req);
}

// Resolve one recall artifact (by exact id, type, or fuzzy match) to its most
// readable content — markdown sibling preferred, JSON/text otherwise.
async function handleRecallDetail(xmRoot, id, req) {
  const { resolveSelector, readableContent } = await getRecallEngine();
  if (typeof resolveSelector !== 'function') {
    return jsonResponseWithETag({ error: 'recall_unavailable' }, req, 503);
  }
  const art = resolveSelector(xmRoot, id);
  if (!art) return jsonResponseWithETag({ error: 'not_found', id }, req, 404);
  const content = typeof readableContent === 'function'
    ? readableContent(art)
    : { path: art.path, text: null };
  return jsonResponseWithETag({ artifact: art, content }, req);
}

// x-panel runs: live status.json (in-progress) + verdict.json (done) per run.
// Two run families share this list: `review` runs (.xm/panel/, findings-based adversarial
// review) and `cross` runs (.xm/cross/, generic cross-vendor invocations by op/build/solver/
// eval). Each carries a `kind` + a `source` provenance tag + a human `title` so the list is
// identifiable at a glance instead of showing bare timestamps or literal-target fragments.
function collectPanelRuns(xmRoot) {
  const runs = [];

  // ── review runs (.xm/panel/) ──────────────────────────────────────────
  const dir = safeJoin(xmRoot, 'panel');
  if (dir && existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rdir = safeJoin(dir, entry.name);
      if (!rdir) continue;
      let status = null, verdict = null;
      try { status = JSON.parse(readFileSync(join(rdir, 'status.json'), 'utf8')); } catch { /* older/older run */ }
      try {
        const v = JSON.parse(readFileSync(join(rdir, 'verdict.json'), 'utf8'));
        verdict = { counts: v.counts, models: v.models, created_at: v.created_at, usage: v.usage || null, target_title: v.target_title || null };
      } catch { /* not finished */ }
      // Prefer the finished verdict's title; fall back to the live status (in-progress runs).
      const target_title = (verdict && verdict.target_title) || (status && status.target_title) || null;
      // Source = review(<target_kind>) so the list shows what was reviewed (literal/file/diff)
      // even when the title itself is a cryptic fragment like "status" or "-help".
      const target_kind = (status && status.target_kind) || null;
      const source = target_kind ? `review(${target_kind})` : 'review';
      runs.push({ run: entry.name, kind: 'review', source, title: target_title, status, verdict, target_title });
    }
  }

  // ── cross runs (.xm/cross/) ───────────────────────────────────────────
  const cdir = safeJoin(xmRoot, 'cross');
  if (cdir && existsSync(cdir)) {
    for (const entry of readdirSync(cdir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rdir = safeJoin(cdir, entry.name);
      if (!rdir) continue;
      let result = null;
      try { result = JSON.parse(readFileSync(join(rdir, 'result.json'), 'utf8')); } catch { /* in-progress or crashed */ }
      if (result) {
        const okCount = (result.results || []).filter((r) => r && r.ok).length;
        const phase = okCount ? 'done' : ((result.results || []).length ? 'failed' : 'done');
        runs.push({
          run: entry.name, kind: 'cross',
          source: result.source || 'cross',
          title: result.title || null,
          models: result.models || [],
          vendor_count: (result.models || []).length,
          prompt_chars: result.prompt_chars || null,
          created_at: result.created_at || null,
          ok_count: okCount,
          phase,
          status: null, verdict: null,
        });
      } else {
        // result.json not written yet — surface the run as in-progress using whatever
        // per-vendor files have landed, so a live cross run isn't invisible.
        const labels = readdirSync(rdir).filter((f) => f.endsWith('.json') && f !== 'result.json').map((f) => f.replace(/\.json$/, ''));
        if (!labels.length) continue;
        runs.push({
          run: entry.name, kind: 'cross', source: 'cross', title: null,
          models: labels, vendor_count: labels.length, prompt_chars: null,
          created_at: null, phase: 'running', status: null, verdict: null,
        });
      }
    }
  }

  // run ids share the panel-<timestamp>-<rand> format across both families, so a plain
  // descending sort interleaves review + cross runs in reverse-chronological order.
  runs.sort((a, b) => b.run.localeCompare(a.run));
  return runs;
}

// A run is still "live": a cross run with no result.json yet, or a review run whose status.json
// is non-final AND was touched recently (older than this window = the process died mid-run, so it
// is stale, not live — mirrors the client's PANEL_STALE_MS so server/UI agree).
const PANEL_STALE_MS = 30000;
function isPanelRunLive(run) {
  if (run.kind === 'cross') return run.phase === 'running';
  const st = run.status;
  if (!st || st.phase === 'done') return false;
  const t = Date.parse(st.updated_at || '');
  return Number.isFinite(t) && (Date.now() - t) < PANEL_STALE_MS;
}

function handlePanelList(xmRoot, req) {
  return jsonResponseWithETag({ runs: collectPanelRuns(xmRoot) }, req);
}

// Cross-workspace aggregate: every project's live (+ a few recent) panel/cross runs in one
// payload, so a multi-agent / multi-project session sees ALL running panels on one screen instead
// of switching workspaces one at a time. Works in every mode — single-project (one workspace),
// registry, or --scan (N workspaces). Workspaces with no panel activity are omitted.
function handlePanelsAll(req) {
  const out = [];
  for (const ws of getAllWorkspaces()) {
    if (!ws || !ws.xmRoot) continue;
    let runs = [];
    try { runs = collectPanelRuns(ws.xmRoot); } catch { runs = []; }
    if (!runs.length) continue;
    const live = runs.filter(isPanelRunLive);
    const recent = runs.filter((r) => !isPanelRunLive(r)).slice(0, 8);
    out.push({ id: ws.id, name: ws.name, path: ws.path || null, live_count: live.length, total: runs.length, runs: [...live, ...recent] });
  }
  // projects with live runs float to the top, then alphabetical — the eye lands on activity first.
  out.sort((a, b) => (b.live_count - a.live_count) || String(a.name).localeCompare(String(b.name)));
  return jsonResponseWithETag({ workspaces: out, generated_at: new Date().toISOString() }, req);
}

function readPanelEvents(runDir, req) {
  let limit = 120;
  try {
    const url = new URL(req.url);
    const raw = Number.parseInt(url.searchParams.get('events') || '', 10);
    if (Number.isFinite(raw)) limit = Math.min(500, Math.max(0, raw));
  } catch { /* keep default */ }
  if (limit === 0) return [];
  try {
    const lines = readFileSync(join(runDir, 'events.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit);
    const events = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* skip corrupt partial line */ }
    }
    return events;
  } catch {
    return [];
  }
}

// One panel run, fully: verdict.json (consensus/confirmed/contested/by_model),
// live status.json, and each model's round1 findings + round2 verdicts (the
// intermediate content). The bulky raw model output is dropped — findings and
// verdicts carry the structured claims/refutals the detail view renders.
function handlePanelDetail(xmRoot, run, req) {
  const dir = safeJoin(xmRoot, 'panel');
  if (!dir) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const rdir = safeJoin(dir, run);
  if (!rdir || !existsSync(rdir)) return handleCrossDetail(xmRoot, run, req);
  const read = (f) => { try { return JSON.parse(readFileSync(join(rdir, f), 'utf8')); } catch { return null; } };
  const verdict = read('verdict.json');
  const status = read('status.json');
  const rounds = {};
  for (const ent of readdirSync(rdir)) {
    const m = ent.match(/^(.+)\.r([12])\.json$/);
    if (!m) continue;
    const [, fileLabel, r] = m;
    const data = read(ent);
    if (!data) continue;
    // Key by the raw model label stored in the file, not the sanitized filename —
    // a label with ':' (e.g. codex:gpt-5) is filename-safe-mangled, so keying by
    // the filename would split it from the status/verdict label into two cards.
    const label = data.model || fileLabel;
    rounds[label] = rounds[label] || { label };
    if (r === '1') rounds[label].r1 = { ok: data.ok, error: data.error, findings: data.findings || [] };
    else rounds[label].r2 = { ok: data.ok, error: data.error, verdicts: data.verdicts || [] };
  }
  if (!verdict && !status && Object.keys(rounds).length === 0) {
    return jsonResponseWithETag({ error: 'not_found', run }, req, 404);
  }
  return jsonResponseWithETag({ run, kind: 'review', verdict, status, rounds: Object.values(rounds), events: readPanelEvents(rdir, req) }, req);
}

// One cross-vendor run (.xm/cross/<run>/): each vendor's free-form text output. No findings,
// no rounds — the caller (op/build/solver/eval) did its own synthesis. The detail view shows
// the raw per-vendor deliberation so the cross run isn't a dead-end card in the list.
function handleCrossDetail(xmRoot, run, req) {
  const cdir = safeJoin(xmRoot, 'cross');
  const rdir = cdir && safeJoin(cdir, run);
  if (!rdir || !existsSync(rdir)) return jsonResponseWithETag({ error: 'not_found', run }, req, 404);
  let result = null;
  try { result = JSON.parse(readFileSync(join(rdir, 'result.json'), 'utf8')); } catch { /* in-progress */ }
  if (!result) {
    // result.json not written yet — assemble from the per-vendor files that have landed.
    const results = [];
    for (const f of readdirSync(rdir)) {
      if (!f.endsWith('.json') || f === 'result.json') continue;
      try { results.push(JSON.parse(readFileSync(join(rdir, f), 'utf8'))); } catch { /* skip partial */ }
    }
    if (!results.length) return jsonResponseWithETag({ error: 'not_found', run }, req, 404);
    return jsonResponseWithETag({ run, kind: 'cross', source: 'cross', title: null, models: results.map((r) => r.model), phase: 'running', results }, req);
  }
  return jsonResponseWithETag({
    run, kind: 'cross',
    source: result.source || 'cross',
    title: result.title || null,
    models: result.models || [],
    prompt_chars: result.prompt_chars || null,
    created_at: result.created_at || null,
    phase: 'done',
    results: result.results || [],
  }, req);
}

// Reuse x-panel's provider adapters (PATH detection) instead of re-implementing
// which CLIs are installed. adapters.mjs has no XM_ROOT side effects, so a dynamic
// import is safe; resolve across the bundle (xm/lib/x-panel/) and source tree.
let _panelEngine = null;
async function getPanelEngine() {
  if (_panelEngine) return _panelEngine;
  const here = import.meta.dirname;
  const candidates = [
    join(here, 'x-panel', 'adapters.mjs'),                                // xm bundle: xm/lib/x-panel/adapters.mjs
    join(here, '..', '..', 'x-panel', 'lib', 'x-panel', 'adapters.mjs'),  // source: x-dashboard/lib → x-panel/lib/x-panel/adapters.mjs
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { _panelEngine = await import(p); return _panelEngine; } catch { /* try next */ }
    }
  }
  _panelEngine = { knownProviders: () => [], isAvailable: () => false, listModelIds: async () => ({ ok: false, models: [] }) };
  return _panelEngine;
}

// Live model catalog — the vendor CLIs (cursor/kiro/agy) expose their REAL model
// lists via `--list-models`, but each call spawns a process (~1-3s), so we cache the
// parsed result (TTL) and refresh asynchronously (never blocking the event loop).
// Without this the config form only offered a stale hardcoded list — no cursor
// kimi/glm, no kiro glm — which is exactly the "can't pick kimi/glm" report.
const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;
const _modelCatalog = { models: {}, fetchedAt: 0, refreshing: null };
async function refreshModelCatalog() {
  const eng = await getPanelEngine();
  if (typeof eng.listModelIds !== 'function' || typeof eng.knownProviders !== 'function') return _modelCatalog;
  const out = {};
  await Promise.all(eng.knownProviders().map(async (name) => {
    try { const r = await eng.listModelIds(name); if (r && r.ok && r.models.length) out[name] = r.models; }
    catch (e) { console.error(`[x-dashboard-server] model catalog refresh failed for ${name}: ${e?.message || e}`); }
  }));
  _modelCatalog.models = out;
  _modelCatalog.fetchedAt = Date.now();
  return _modelCatalog;
}
function ensureModelCatalog(force = false) {
  const stale = force || (Date.now() - _modelCatalog.fetchedAt > MODEL_CATALOG_TTL_MS);
  if (stale && !_modelCatalog.refreshing) {
    _modelCatalog.refreshing = refreshModelCatalog().finally(() => { _modelCatalog.refreshing = null; });
  }
  return _modelCatalog.refreshing || Promise.resolve(_modelCatalog);
}
// GET panel models — live per-vendor model catalogs for the config form's datalists.
async function handlePanelModels(req) {
  const force = new URL(req.url).searchParams.get('refresh') === '1';
  await ensureModelCatalog(force);
  return jsonResponseWithETag({ models: _modelCatalog.models, fetchedAt: _modelCatalog.fetchedAt }, req);
}

// GET panel providers — which model CLIs are on PATH (for the config form's model
// checkboxes) + the workspace's merged panel config (global then project wins).
async function handlePanelProviders(xmRoot, req) {
  const { knownProviders, isAvailable } = await getPanelEngine();
  const names = typeof knownProviders === 'function' ? knownProviders() : [];
  const providers = names.map((name) => ({
    name,
    available: typeof isAvailable === 'function' ? !!isAvailable(name) : false,
  }));
  const readPanel = (tier) => {
    const fp = configPathForTier(xmRoot, tier);
    if (!fp || !existsSync(fp)) return {};
    try { return (JSON.parse(readFileSync(fp, 'utf8')).panel) || {}; } catch { return {}; }
  };
  const g = readPanel('global'), p = readPanel('project');
  const panel = { ...g, ...p, presets: { ...(g.presets || {}), ...(p.presets || {}) } };
  return jsonResponseWithETag({ providers, panel }, req);
}

// ── Route handler functions (accept xmRoot parameter) ────────────────

// Resolve the config.json path for a tier. project = the workspace's .xm; global
// = ~/.xm (matches x-panel's globalXmDir, env-overridable to keep tests hermetic).
function configPathForTier(xmRoot, tier) {
  if (tier === 'global') {
    const root = process.env.X_PANEL_GLOBAL_ROOT ? resolve(process.env.X_PANEL_GLOBAL_ROOT) : join(homedir(), '.xm');
    return join(root, 'config.json');
  }
  return safeJoin(xmRoot, 'config.json');
}

function handleConfig(xmRoot, req) {
  const url = new URL(req.url);
  const tier = url.searchParams.get('tier') === 'global' ? 'global' : 'project';
  const filePath = configPathForTier(xmRoot, tier);
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  // A missing config is a valid empty config (editable), not a 404 — the editor
  // needs to render and let the user create one, especially for the global tier.
  if (!existsSync(filePath)) return jsonResponseWithETag({ _tier: tier, _path: filePath, _empty: true }, req);
  try {
    const cfg = JSON.parse(readFileSync(filePath, 'utf8'));
    return jsonResponseWithETag({ ...cfg, _tier: tier, _path: filePath }, req);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file: filePath }, req, 500);
  }
}

// ── cost-engine (lazy, for resolved model routing) ────────────────────
// Resolves across the xm bundle (sibling x-build/) and the standalone source
// tree. null when unavailable — the routing endpoint then degrades to 503 and
// the UI hides its phase-models section.
let _costEngine;
async function getCostEngine() {
  if (_costEngine !== undefined) return _costEngine;
  const here = import.meta.dirname;
  const candidates = [
    join(here, 'x-build', 'cost-engine.mjs'),                                // xm bundle: xm/lib/x-build/
    join(here, '..', '..', 'x-build', 'lib', 'x-build', 'cost-engine.mjs'), // source tree
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { _costEngine = await import(p); return _costEngine; } catch { /* try next */ }
    }
  }
  _costEngine = null;
  return _costEngine;
}

// GET /api/config/model-routing?tier= — resolved role→model matrix so the UI
// never duplicates MODEL_PROFILES. tier=global resolves against the global
// config only; default resolves the effective (global + project) view.
async function handleModelRouting(xmRoot, req) {
  const ce = await getCostEngine();
  if (!ce) return jsonResponseWithETag({ error: 'routing_unavailable' }, req, 503);

  const url = new URL(req.url);
  const tier = url.searchParams.get('tier') === 'global' ? 'global' : 'project';
  const readTier = (t) => {
    const p = configPathForTier(xmRoot, t);
    if (!p || !existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
  };
  const globalCfg = readTier('global');
  const effective = tier === 'global' ? globalCfg : { ...globalCfg, ...readTier('project') };

  const profile = ce.resolveProfileName(effective.model_profile);
  const profileMap = ce.MODEL_PROFILES[profile] || ce.MODEL_PROFILES.default;
  const overrides = (effective.model_overrides && typeof effective.model_overrides === 'object')
    ? effective.model_overrides : {};

  const roles = {};
  for (const role of new Set([...Object.keys(profileMap), ...Object.keys(overrides)])) {
    roles[role] = {
      model: ce.getModelForRole(role, 'medium', effective),
      source: overrides[role] ? 'override' : 'profile',
    };
  }
  return jsonResponseWithETag({
    profile,
    models: ['haiku', 'sonnet', 'opus'],
    phase_groups: ce.PHASE_ROLE_GROUPS,
    roles,
  }, req);
}

function deleteConfigPath(obj, path) {
  if (!obj || typeof obj !== 'object' || typeof path !== 'string') return;
  const parts = path.split('.').map((p) => p.trim()).filter(Boolean);
  const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
  if (!parts.length || parts.some((p) => forbidden.has(p))) return;
  const parents = [];
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return;
    parents.push([cur, part]);
    cur = cur[part];
  }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return;
  delete cur[parts[parts.length - 1]];
  for (let i = parents.length - 1; i >= 0; i--) {
    const [parent, key] = parents[i];
    const child = parent[key];
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
}

// PATCH a tier's config.json — parse-validate the body, apply optional `_delete`
// dot-path removals, then top-level merge into the existing config. Atomic
// tmp+rename write. Never a silent failure (L6): every error returns a code.
const CONFIG_MAX_BYTES = 256 * 1024;
async function handleConfigPatch(xmRoot, req) {
  const url = new URL(req.url);
  const tier = url.searchParams.get('tier') === 'global' ? 'global' : 'project';
  const filePath = configPathForTier(xmRoot, tier);
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);

  let body;
  try { body = await req.json(); }
  catch { return jsonResponseWithETag({ error: 'invalid_json' }, req, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonResponseWithETag({ error: 'expected_object' }, req, 400);
  }
  if (JSON.stringify(body).length > CONFIG_MAX_BYTES) {
    return jsonResponseWithETag({ error: 'too_large', max_bytes: CONFIG_MAX_BYTES }, req, 413);
  }
  const deletePaths = Array.isArray(body._delete) ? body._delete.map((p) => String(p)) : [];
  // Strip GET-only metadata keys the client echoes back (_tier, _path, _empty)
  // and control keys (_delete) so they never land in config.json.
  for (const k of Object.keys(body)) {
    if (k.startsWith('_')) delete body[k];
  }

  let current = {};
  if (existsSync(filePath)) {
    try { current = JSON.parse(readFileSync(filePath, 'utf8')); }
    catch { return jsonResponseWithETag({ error: 'parse_error', file: filePath }, req, 500); }
  }
  for (const p of deletePaths) deleteConfigPath(current, p);
  const next = { ...current, ...body };
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, filePath);
  } catch (e) {
    return jsonResponseWithETag({ error: 'write_failed', message: String(e?.message || e) }, req, 500);
  }
  return jsonResponseWithETag({ ok: true, tier, path: filePath, config: next }, req);
}

function extractGoal(projectDir) {
  for (const file of ['context/CONTEXT.md', 'context/brief.md']) {
    const fp = safeJoin(projectDir, file);
    if (!fp || !existsSync(fp)) continue;
    try {
      const content = readFileSync(fp, 'utf8');
      const m = content.match(/^##\s*Goal\s*\n+(.+)/m);
      if (m) return m[1].trim().slice(0, 200);
    } catch {}
  }
  return null;
}

function readJSONFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function handleProjects(xmRoot, req) {
  const projectsDir = safeJoin(xmRoot, 'build', 'projects');
  if (!projectsDir || !existsSync(projectsDir)) return jsonResponseWithETag({ data: [] }, req);
  const manifests = [];
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = safeJoin(projectsDir, entry.name);
    const manifestPath = safeJoin(projectDir, 'manifest.json');
    if (!manifestPath || !existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.goal = extractGoal(projectDir);
      manifest.later = getProjectLaterData(xmRoot, projectDir).summary;
      manifests.push(manifest);
    } catch {}
  }
  return jsonResponseWithETag({ data: manifests }, req);
}

function handleProjectTasks(xmRoot, slug, req) {
  if (!isValidSegment(slug)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const filePath = safeJoin(xmRoot, 'build', 'projects', slug, 'phases', '02-plan', 'tasks.json');
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  try {
    return jsonResponseWithETag(JSON.parse(readFileSync(filePath, 'utf8')), req);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file: 'tasks.json' }, req, 500);
  }
}

function normalizeLaterData(data) {
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  const summary = { total: items.length, open: 0, promoted: 0, dismissed: 0 };
  let updatedAt = null;

  for (const item of items) {
    const status = item?.status;
    if (status === 'open') summary.open += 1;
    else if (status === 'promoted') summary.promoted += 1;
    else if (status === 'dismissed') summary.dismissed += 1;

    const timestamp = item?.updated_at || item?.created_at || null;
    if (timestamp && (!updatedAt || timestamp > updatedAt)) updatedAt = timestamp;
  }

  return { items, summary, updated_at: updatedAt };
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

// ── Build identity ───────────────────────────────────────────────────
// Content hash of the served browser bundle, so /health can prove WHICH
// public/ is live (cache copy vs working-tree source) and a release gate can
// assert served==source. Same algorithm wherever it runs, so a buildId from
// the source tree (`--print-build-id`) is comparable to a running server's
// /health buildId. Computed once at startup; the bundle can't change without
// a restart.
// Every asset the browser actually loads from index.html — keep in sync with the
// <script>/<link> tags. Omitting one (e.g. render-helpers.js) lets a changed-but-
// unhashed bundle pass the served==source gate as "live" while serving stale code.
const BUILD_ASSETS = ['index.html', 'style.css', 'vendor/marked.js', 'vendor/chart.js', 'render-helpers.js', 'app.js'];
function computeBuildId(publicDir) {
  const h = createHash('sha256');
  const assets = {};
  for (const name of BUILD_ASSETS) {
    const p = join(publicDir, name);
    if (!existsSync(p)) { assets[name] = null; continue; }
    const buf = readFileSync(p);
    assets[name] = createHash('sha256').update(buf).digest('hex').slice(0, 12);
    h.update(name).update('\0').update(buf).update('\0');
  }
  return { buildId: h.digest('hex').slice(0, 12), assets };
}
const BUILD = computeBuildId(PUBLIC_DIR);

function laterSnapshotStatus(xmRoot, item) {
  const snapshots = Array.isArray(item?.file_snapshots) ? item.file_snapshots : [];
  if (snapshots.length === 0) return { tracked: 0, changed: 0, files: [] };

  const workspaceRoot = resolve(xmRoot, '..');
  const files = [];
  for (const snapshot of snapshots) {
    const rel = String(snapshot?.file || '').trim();
    if (!rel) continue;
    const abs = safeJoin(workspaceRoot, rel);
    if (!abs) {
      files.push({ file: rel, changed: true, reason: 'path_escape' });
      continue;
    }
    const exists = existsSync(abs);
    const sha256 = exists ? hashFile(abs) : null;
    files.push({
      file: rel,
      changed: exists !== snapshot.exists || sha256 !== snapshot.sha256,
      before_exists: snapshot.exists,
      after_exists: exists,
    });
  }

  return {
    tracked: files.length,
    changed: files.filter(file => file.changed).length,
    files,
  };
}

function getProjectLaterData(xmRoot, projectDir) {
  const filePath = safeJoin(projectDir, 'later.json');
  if (!filePath || !existsSync(filePath)) return normalizeLaterData({ items: [] });

  const parsed = readJSONFile(filePath);
  if (!parsed) return { ...normalizeLaterData({ items: [] }), parse_error: true };

  const data = normalizeLaterData(parsed);
  data.items = data.items.map(item => ({
    ...item,
    scope: laterSnapshotStatus(xmRoot, item),
  }));
  return data;
}

function handleProjectLater(xmRoot, slug, req) {
  if (!isValidSegment(slug)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const projectDir = safeJoin(xmRoot, 'build', 'projects', slug);
  if (!projectDir || !existsSync(projectDir)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);

  const data = getProjectLaterData(xmRoot, projectDir);
  if (data.parse_error) return jsonResponseWithETag({ error: 'parse_error', file: 'later.json' }, req, 500);
  return jsonResponseWithETag(data, req);
}

function handleLaterAll(xmRoot, req) {
  const projectsDir = safeJoin(xmRoot, 'build', 'projects');
  const summary = { total: 0, open: 0, promoted: 0, dismissed: 0, changed_scope: 0 };
  const projects = [];
  const items = [];
  if (!projectsDir || !existsSync(projectsDir)) return jsonResponseWithETag({ data: [], projects: [], summary }, req);

  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = safeJoin(projectsDir, entry.name);
    const manifestPath = safeJoin(projectDir, 'manifest.json');
    if (!projectDir || !manifestPath || !existsSync(manifestPath)) continue;
    const manifest = readJSONFile(manifestPath);
    if (!manifest) continue;
    const later = getProjectLaterData(xmRoot, projectDir);
    if (later.parse_error) continue;
    const project = {
      name: entry.name,
      display_name: manifest.display_name || manifest.name || entry.name,
      current_phase: manifest.current_phase || null,
      updated_at: manifest.updated_at || null,
      summary: later.summary,
      updated_later_at: later.updated_at,
    };
    projects.push(project);

    for (const item of later.items) {
      const scopeChanged = item.scope?.changed || 0;
      summary.changed_scope += scopeChanged > 0 ? 1 : 0;
      items.push({
        ...item,
        project: entry.name,
        project_display_name: project.display_name,
        project_phase: project.current_phase,
      });
    }

    summary.total += later.summary.total;
    summary.open += later.summary.open;
    summary.promoted += later.summary.promoted;
    summary.dismissed += later.summary.dismissed;
  }

  projects.sort((a, b) => (b.updated_later_at || b.updated_at || '').localeCompare(a.updated_later_at || a.updated_at || ''));
  items.sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));
  return jsonResponseWithETag({ data: items, projects, summary }, req);
}

function handleProjectGate(xmRoot, slug, req) {
  if (!isValidSegment(slug)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const projectDir = safeJoin(xmRoot, 'build', 'projects', slug);
  if (!projectDir || !existsSync(projectDir)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);

  const manifestPath = safeJoin(projectDir, 'manifest.json');
  const manifest = manifestPath && existsSync(manifestPath) ? readJSONFile(manifestPath) : {};
  const phasesDir = safeJoin(projectDir, 'phases');
  const currentPhase = manifest?.current_phase || null;
  const phaseDir = currentPhase && phasesDir ? safeJoin(phasesDir, currentPhase) : null;
  const files = phaseDir && existsSync(phaseDir)
    ? readdirSync(phaseDir, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name).sort()
    : [];
  const statusPath = phaseDir ? safeJoin(phaseDir, 'status.json') : null;
  const status = statusPath && existsSync(statusPath) ? readJSONFile(statusPath) : null;
  const tasksPath = phaseDir ? safeJoin(phaseDir, 'tasks.json') : null;
  const tasksData = tasksPath && existsSync(tasksPath) ? readJSONFile(tasksPath) : null;
  const tasks = Array.isArray(tasksData) ? tasksData : Array.isArray(tasksData?.tasks) ? tasksData.tasks : [];
  const pendingTasks = tasks.filter(task => !['completed', 'done'].includes(String(task.status || '').toLowerCase())).length;
  const requiredByPhase = {
    '01-research': ['status.json'],
    '02-plan': ['tasks.json'],
    '03-execute': ['tasks.json'],
    '04-verify': ['status.json'],
    '05-close': ['status.json'],
  };
  const expected = requiredByPhase[currentPhase] || ['status.json'];
  const missing = expected.filter(file => !files.includes(file));
  const nextCommands = [
    'x-build next',
    pendingTasks > 0 ? 'x-build run' : null,
    currentPhase === '04-verify' ? 'x-build quality' : null,
    missing.length === 0 ? 'x-build phase next' : null,
  ].filter(Boolean);

  return jsonResponseWithETag({
    current_phase: currentPhase,
    status,
    files,
    missing,
    tasks: { total: tasks.length, pending: pendingTasks },
    ready: missing.length === 0 && pendingTasks === 0,
    commands: nextCommands,
  }, req);
}

function normalizeSeverity(value) {
  return String(value || '').toLowerCase();
}

function normalizeVerdict(value) {
  return String(value || '').toLowerCase().replace(/[\s-]+/g, '_');
}

function reviewFixGateData(xmRoot) {
  const reviewDir = safeJoin(xmRoot, 'review');
  const resultPath = reviewDir ? safeJoin(reviewDir, 'last-result.json') : null;
  const triagePath = reviewDir ? safeJoin(reviewDir, 'triage.json') : null;
  const review = resultPath && existsSync(resultPath) ? readJSONFile(resultPath) : null;
  const triage = triagePath && existsSync(triagePath) ? readJSONFile(triagePath) : null;
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const requiredSeverities = new Set(['critical', 'high', 'medium']);
  const blockingSeverities = new Set(['critical', 'high']);
  const required = findings
    .map((finding, index) => ({ ...finding, id: `F${index + 1}`, severity: normalizeSeverity(finding.severity) }))
    .filter(finding => requiredSeverities.has(finding.severity));
  const triageItems = Array.isArray(triage?.target_findings) ? triage.target_findings : Array.isArray(triage?.findings) ? triage.findings : [];
  const triageMap = new Map(triageItems.map(item => [item.id || item.finding_id, item]));
  const decisions = { fix_now: 0, backlog: 0, accept_risk: 0, false_positive: 0, undecided: 0 };
  const failures = [];

  if (!review) {
    return {
      status: 'no_review',
      review: null,
      triage: null,
      required: [],
      decisions,
      failures: [],
      commands: ['x-review diff'],
    };
  }

  const verdict = normalizeVerdict(review.verdict);
  if (!triage && required.length > 0 && !['lgtm', 'pass'].includes(verdict)) {
    failures.push('Missing .xm/review/triage.json');
  }

  for (const finding of required) {
    const item = triageMap.get(finding.id);
    const decision = String(item?.decision || '').trim().toLowerCase();
    if (!decision) {
      decisions.undecided += 1;
      failures.push(`${finding.id}: missing triage decision`);
      continue;
    }
    if (decisions[decision] != null) decisions[decision] += 1;
    if (blockingSeverities.has(finding.severity) && decision === 'backlog') {
      failures.push(`${finding.id}: ${finding.severity} cannot be moved to backlog`);
    }
    if ((decision === 'accept_risk' || decision === 'false_positive') && !String(item?.evidence || '').trim()) {
      failures.push(`${finding.id}: ${decision} requires evidence`);
    }
  }

  if (review.reviewed_commit && triage?.reviewed_commit && review.reviewed_commit !== triage.reviewed_commit) {
    failures.push('triage reviewed_commit does not match last review');
  }

  const allowedFiles = Array.isArray(triage?.fix_scope?.allowed_files) ? triage.fix_scope.allowed_files : [];
  const verification = Array.isArray(triage?.verification) ? triage.verification : Array.isArray(triage?.fix_scope?.verification) ? triage.fix_scope.verification : [];
  const status = failures.length > 0
    ? 'blocked'
    : required.length === 0 && ['lgtm', 'pass'].includes(verdict)
      ? 'passed'
      : 'ready';

  return {
    status,
    review: {
      verdict: review.verdict || null,
      reviewed_commit: review.reviewed_commit || null,
      findings: findings.length,
      required: required.length,
    },
    triage: triage ? {
      reviewed_commit: triage.reviewed_commit || null,
      allowed_files: allowedFiles,
      verification,
    } : null,
    required: required.map(finding => ({
      id: finding.id,
      severity: finding.severity,
      file: finding.file || null,
      line: finding.line ?? null,
      summary: finding.summary || finding.description || finding.title || '',
      decision: triageMap.get(finding.id)?.decision || '',
    })),
    decisions,
    failures,
    commands: triage ? ['x-build verify-review-fix', 'x-build quality', 'x-review diff'] : ['x-build verify-review-fix --init'],
  };
}

function handleReviewGate(xmRoot, req) {
  try {
    return jsonResponseWithETag(reviewFixGateData(xmRoot), req);
  } catch {
    return jsonResponseWithETag({ error: 'read_error' }, req, 500);
  }
}

function handleProjectDetail(xmRoot, slug, req) {
  if (!isValidSegment(slug)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const projectDir = safeJoin(xmRoot, 'build', 'projects', slug);
  if (!projectDir || !existsSync(projectDir)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);

  const manifestPath = safeJoin(projectDir, 'manifest.json');
  if (!manifestPath || !existsSync(manifestPath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file: 'manifest.json' }, req, 500);
  }

  let circuitBreaker = null;
  const cbPath = safeJoin(projectDir, 'circuit-breaker.json');
  if (cbPath && existsSync(cbPath)) {
    try { circuitBreaker = JSON.parse(readFileSync(cbPath, 'utf8')); } catch {}
  }

  let handoff = null;
  const handoffPath = safeJoin(projectDir, 'HANDOFF.json');
  if (handoffPath && existsSync(handoffPath)) {
    try { handoff = JSON.parse(readFileSync(handoffPath, 'utf8')); } catch {}
  }

  const phases = [];
  const phasesDir = safeJoin(projectDir, 'phases');
  if (phasesDir && existsSync(phasesDir)) {
    for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statusPath = safeJoin(phasesDir, entry.name, 'status.json');
      if (!statusPath || !existsSync(statusPath)) continue;
      try {
        phases.push({ phase: entry.name, ...JSON.parse(readFileSync(statusPath, 'utf8')) });
      } catch {}
    }
  }

  const context = [];
  const contextDir = safeJoin(projectDir, 'context');
  if (contextDir && existsSync(contextDir)) {
    for (const entry of readdirSync(contextDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const mdPath = safeJoin(contextDir, entry.name);
      if (!mdPath) continue;
      try {
        context.push({ name: entry.name, content: readFileSync(mdPath, 'utf8') });
      } catch {}
    }
  }

  // Also collect MD files from phase directories (PRD, roadmap, notes, summaries, checklists)
  const phasesMdDir = safeJoin(projectDir, 'phases');
  if (phasesMdDir && existsSync(phasesMdDir)) {
    for (const phaseEntry of readdirSync(phasesMdDir, { withFileTypes: true })) {
      if (!phaseEntry.isDirectory()) continue;
      const phaseDir = safeJoin(phasesMdDir, phaseEntry.name);
      if (!phaseDir) continue;
      for (const file of readdirSync(phaseDir)) {
        if (!file.endsWith('.md')) continue;
        const mdPath = safeJoin(phaseDir, file);
        if (!mdPath) continue;
        try {
          context.push({ name: `${phaseEntry.name}/${file}`, content: readFileSync(mdPath, 'utf8') });
        } catch {}
      }
    }
  }

  // Decisions — try decisions.json first, fallback to decisions.md
  let decisions = [];
  const decisionsJsonPath = safeJoin(projectDir, 'context', 'decisions.json');
  if (decisionsJsonPath && existsSync(decisionsJsonPath)) {
    try {
      const dd = JSON.parse(readFileSync(decisionsJsonPath, 'utf8'));
      decisions = (dd.decisions || []).slice(-5);
    } catch {}
  }
  if (decisions.length === 0) {
    // Fallback: parse decisions.md for bullet items
    const decisionsMdPath = safeJoin(projectDir, 'context', 'decisions.md');
    if (decisionsMdPath && existsSync(decisionsMdPath)) {
      try {
        const md = readFileSync(decisionsMdPath, 'utf8');
        const lines = md.split('\n').filter(l => l.startsWith('- ')).slice(-5);
        decisions = lines.map(l => ({ title: l.slice(2).trim() }));
      } catch {}
    }
  }

  // Steps + Tasks — search all phase dirs for steps.json/tasks.json
  let steps = { total: 0, completed: 0 };
  let allTasks = [];
  const phasesSearchDir = safeJoin(projectDir, 'phases');
  if (phasesSearchDir && existsSync(phasesSearchDir)) {
    for (const entry of readdirSync(phasesSearchDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sp = safeJoin(phasesSearchDir, entry.name, 'steps.json');
      const tp = safeJoin(phasesSearchDir, entry.name, 'tasks.json');
      if (sp && existsSync(sp) && steps.total === 0) {
        try {
          const sd = JSON.parse(readFileSync(sp, 'utf8'));
          const td = (tp && existsSync(tp)) ? JSON.parse(readFileSync(tp, 'utf8')) : { tasks: [] };
          allTasks = td.tasks || [];
          steps.total = sd.steps?.length || 0;
          steps.completed = (sd.steps || []).filter(w => w.tasks.every(id => allTasks.find(t => t.id === id)?.status === 'completed')).length;
        } catch {}
      } else if (tp && existsSync(tp) && allTasks.length === 0) {
        try { allTasks = JSON.parse(readFileSync(tp, 'utf8')).tasks || []; } catch {}
      }
    }
  }

  // Cost from metrics
  let cost = 0;
  const metricsDir = safeJoin(xmRoot, 'build', 'metrics');
  const metricsFile = metricsDir ? safeJoin(metricsDir, 'sessions.jsonl') : null;
  if (metricsFile && existsSync(metricsFile)) {
    for (const m of parseJsonlFile(metricsFile)) {
      if (typeof m.cost_usd === 'number' && m.project === slug) cost += m.cost_usd;
    }
  }

  // Quality (avg score from tasks found above)
  let quality = null;
  const scored = allTasks.filter(t => t.score != null);
  if (scored.length > 0) quality = scored.reduce((s, t) => s + t.score, 0) / scored.length;

  // Checkpoints — filenames in build/projects/<slug>/checkpoints/*.json
  let checkpoints = [];
  const checkpointsDir = safeJoin(projectDir, 'checkpoints');
  if (checkpointsDir && existsSync(checkpointsDir)) {
    try {
      for (const entry of readdirSync(checkpointsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        // e.g. 2026-04-10T12-10-15-265Z-gate-pass.json → ts, type
        const m = entry.name.match(/^([0-9T\-:.Z]+?)-([a-zA-Z][a-zA-Z0-9-]*)\.json$/);
        if (m) {
          checkpoints.push({ ts: m[1].replace(/-(\d{3}Z)$/, '.$1'), type: m[2] });
        } else {
          checkpoints.push({ ts: null, type: entry.name.replace(/\.json$/, '') });
        }
      }
      checkpoints.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    } catch {}
  }

  // plan_check — phases/02-plan/plan-check.json
  let plan_check = null;
  const planCheckPath = safeJoin(projectDir, 'phases', '02-plan', 'plan-check.json');
  if (planCheckPath && existsSync(planCheckPath)) {
    try { plan_check = JSON.parse(readFileSync(planCheckPath, 'utf8')); } catch {}
  }

  // review_fix_gate_snapshot — xmRoot/review/review-fix-gate.json
  let review_fix_gate_snapshot = null;
  const reviewFixGatePath = safeJoin(xmRoot, 'review', 'review-fix-gate.json');
  if (reviewFixGatePath && existsSync(reviewFixGatePath)) {
    try { review_fix_gate_snapshot = JSON.parse(readFileSync(reviewFixGatePath, 'utf8')); } catch {}
  }

  return jsonResponseWithETag({ manifest, circuitBreaker, handoff, phases, context, decisions, steps, cost: Math.round(cost * 10000) / 10000, quality, checkpoints, plan_check, review_fix_gate_snapshot }, req);
}

function handleSessionState(xmRoot, req) {
  const buildDir = safeJoin(xmRoot, 'build', 'projects');
  const projects = [];

  if (buildDir && existsSync(buildDir)) {
    for (const entry of readdirSync(buildDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mPath = safeJoin(buildDir, entry.name, 'manifest.json');
      if (!mPath || !existsSync(mPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(mPath, 'utf8'));

        // Find tasks
        let taskTotal = 0, taskCompleted = 0, taskFailed = 0;
        const phasesDir = safeJoin(buildDir, entry.name, 'phases');
        if (phasesDir && existsSync(phasesDir)) {
          for (const ph of readdirSync(phasesDir, { withFileTypes: true })) {
            if (!ph.isDirectory()) continue;
            const tp = safeJoin(phasesDir, ph.name, 'tasks.json');
            if (tp && existsSync(tp)) {
              try {
                const td = JSON.parse(readFileSync(tp, 'utf8'));
                const tasks = td.tasks || [];
                taskTotal = tasks.length;
                taskCompleted = tasks.filter(t => t.status === 'completed').length;
                taskFailed = tasks.filter(t => t.status === 'failed').length;
              } catch {}
              break;
            }
          }
        }

        // Decisions
        let decisions = [];
        const djPath = safeJoin(buildDir, entry.name, 'context', 'decisions.json');
        const dmPath = safeJoin(buildDir, entry.name, 'context', 'decisions.md');
        if (djPath && existsSync(djPath)) {
          try { decisions = (JSON.parse(readFileSync(djPath, 'utf8')).decisions || []).slice(-3); } catch {}
        } else if (dmPath && existsSync(dmPath)) {
          try { decisions = readFileSync(dmPath, 'utf8').split('\n').filter(l => l.startsWith('- ')).slice(-3).map(l => ({ title: l.slice(2).trim() })); } catch {}
        }

        projects.push({
          name: entry.name,
          display_name: manifest.display_name || entry.name,
          phase: manifest.current_phase,
          tasks: { total: taskTotal, completed: taskCompleted, failed: taskFailed },
          decisions: decisions.map(d => d.title || d.message || d),
          created_at: manifest.created_at,
          updated_at: manifest.updated_at,
        });
      } catch {}
    }
  }

  // Sort by updated_at desc
  projects.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

  // Active = not in close phase
  const active = projects.filter(p => p.phase !== '05-close');
  const recent = projects.filter(p => p.phase === '05-close').slice(0, 5);

  // All decisions from active projects
  const allDecisions = [];
  for (const p of active) {
    for (const d of p.decisions) {
      allDecisions.push({ project: p.name, decision: d });
    }
  }

  // SESSION-STATE.json (workspace-level handoff from /x-handoff)
  let sessionHandoff = null;
  const sessionStatePath = safeJoin(xmRoot, 'build', 'SESSION-STATE.json');
  if (sessionStatePath && existsSync(sessionStatePath)) {
    try { sessionHandoff = JSON.parse(readFileSync(sessionStatePath, 'utf8')); } catch {}
  }

  return jsonResponseWithETag({ active, recent, decisions: allDecisions.slice(-10), session_handoff: sessionHandoff, generated_at: new Date().toISOString() }, req);
}

function handleProbeLatest(xmRoot, req) {
  const filePath = safeJoin(xmRoot, 'probe', 'last-verdict.json');
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  try {
    return jsonResponseWithETag(JSON.parse(readFileSync(filePath, 'utf8')), req);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file: 'last-verdict.json' }, req, 500);
  }
}

// Shared permissive filename rule — matches host-suffixed sync copies
// like "2026-04-05-global-xm-rethink.Jinwoos-MacBook-Pro-620.local-6339.json".
// See also OP_FILE_RE / HUMBLE_FILE_RE usages.
const PROBE_FILE_RE = /^[a-zA-Z0-9_-]+\.json$/;

function handleProbeHistoryFile(xmRoot, file, req) {
  const fileName = file.endsWith('.json') ? file : file + '.json';
  if (!PROBE_FILE_RE.test(fileName)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const filePath = safeJoin(xmRoot, 'probe', 'history', fileName);
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  try {
    return jsonResponseWithETag(JSON.parse(readFileSync(filePath, 'utf8')), req);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file: fileName }, req, 500);
  }
}

function readProbeFile(xmRoot, param) {
  if (param === 'latest') {
    const filePath = safeJoin(xmRoot, 'probe', 'last-verdict.json');
    if (!filePath) return { error: 'forbidden', status: 400 };
    if (!existsSync(filePath)) return { error: 'not_found', status: 404 };
    try {
      return { data: JSON.parse(readFileSync(filePath, 'utf8')), file: 'latest' };
    } catch {
      return { error: 'parse_error', status: 500 };
    }
  }
  const baseName = param.endsWith('.json') ? param.slice(0, -5) : param;
  // Allow date-based names like 2026-04-03-xm-web-dashboard
  const PROBE_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
  if (!PROBE_SEGMENT_RE.test(baseName)) return { error: 'forbidden', status: 400 };
  const fileName = param.endsWith('.json') ? param : param + '.json';
  const filePath = safeJoin(xmRoot, 'probe', 'history', fileName);
  if (!filePath) return { error: 'forbidden', status: 400 };
  if (!existsSync(filePath)) return { error: 'not_found', status: 404 };
  try {
    return { data: JSON.parse(readFileSync(filePath, 'utf8')), file: fileName };
  } catch {
    return { error: 'parse_error', status: 500 };
  }
}

function setDiff(a, b) {
  return {
    added: b.filter(x => !a.includes(x)),
    removed: a.filter(x => !b.includes(x)),
    unchanged: a.filter(x => b.includes(x)),
  };
}

function diffVerdicts(a, b) {
  const diff = {
    verdict: { a: a.verdict, b: b.verdict, changed: a.verdict !== b.verdict },
    idea: { a: a.idea, b: b.idea },
    recommendation: { a: a.recommendation, b: b.recommendation, changed: a.recommendation !== b.recommendation },
    premises: { added: [], removed: [], changed: [], unchanged: [] },
    evidence_summary: { a: a.evidence_summary, b: b.evidence_summary },
  };

  const aPremises = a.premises || [];
  const bPremises = b.premises || [];

  const bMatched = new Set();
  for (const ap of aPremises) {
    const matchIdx = bPremises.findIndex((bp, i) => !bMatched.has(i) && (bp.statement === ap.statement || bp.id === ap.id));
    if (matchIdx !== -1) {
      bMatched.add(matchIdx);
      const match = bPremises[matchIdx];
      if (ap.status !== match.status || ap.final_grade !== match.final_grade) {
        diff.premises.changed.push({ a: ap, b: match });
      } else {
        diff.premises.unchanged.push(match);
      }
    } else {
      diff.premises.removed.push(ap);
    }
  }
  for (let i = 0; i < bPremises.length; i++) {
    if (!bMatched.has(i)) diff.premises.added.push(bPremises[i]);
  }

  diff.evidence_gaps = setDiff(a.evidence_gaps || [], b.evidence_gaps || []);
  diff.risks = setDiff(a.risks || [], b.risks || []);
  diff.kill_criteria = setDiff(a.kill_criteria || [], b.kill_criteria || []);

  return diff;
}

function handleProbeDiff(xmRoot, url, req) {
  const aParam = url.searchParams.get('a');
  const bParam = url.searchParams.get('b');
  if (!aParam || !bParam) return jsonResponseWithETag({ error: 'missing_param', required: ['a', 'b'] }, req, 400);

  const aResult = readProbeFile(xmRoot, decodeURIComponent(aParam));
  if (aResult.error) return jsonResponseWithETag({ error: aResult.error, file: aParam }, req, aResult.status);

  const bResult = readProbeFile(xmRoot, decodeURIComponent(bParam));
  if (bResult.error) return jsonResponseWithETag({ error: bResult.error, file: bParam }, req, bResult.status);

  const diff = diffVerdicts(aResult.data, bResult.data);
  return jsonResponseWithETag({
    a: { file: aResult.file, idea: aResult.data.idea, verdict: aResult.data.verdict },
    b: { file: bResult.file, idea: bResult.data.idea, verdict: bResult.data.verdict },
    diff,
  }, req);
}

function handleProbeHistory(xmRoot, req) {
  const historyDir = safeJoin(xmRoot, 'probe', 'history');
  if (!historyDir || !existsSync(historyDir)) return jsonResponseWithETag({ data: [] }, req);
  const results = [];
  for (const entry of readdirSync(historyDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = safeJoin(historyDir, entry.name);
    if (!filePath) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      parsed._file = entry.name;
      results.push(parsed);
    } catch {}
  }
  results.sort((a, b) => {
    const da = a.date ?? a.timestamp ?? a.created_at ?? '';
    const db = b.date ?? b.timestamp ?? b.created_at ?? '';
    return db < da ? -1 : db > da ? 1 : 0;
  });
  return jsonResponseWithETag({ data: results }, req);
}

// ── x-op result handlers ───────────────────────────────────────────

function handleOpList(xmRoot, req) {
  const opDir = safeJoin(xmRoot, 'op');
  if (!opDir || !existsSync(opDir)) return jsonResponseWithETag({ data: [] }, req);
  const results = [];
  for (const entry of readdirSync(opDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = safeJoin(opDir, entry.name);
    if (!filePath) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      parsed._file = entry.name;
      results.push(parsed);
    } catch {}
  }
  results.sort((a, b) => {
    // Newer op schemas (v2: brainstorm/council/investigate/debate/tournament)
    // store the timestamp at the root `date` field rather than the nested
    // completed_at/created_at — include those in the sort key so the list is
    // ordered correctly across schema generations.
    const da = a.completed_at ?? a.created_at ?? a.date ?? a.timestamp ?? '';
    const db = b.completed_at ?? b.created_at ?? b.date ?? b.timestamp ?? '';
    return db < da ? -1 : db > da ? 1 : 0;
  });
  return jsonResponseWithETag({ data: results }, req);
}

// Op file names routinely contain dots (x-sync adds host suffixes like
// ".{host}-{hash}.json"), so we use the same permissive rule as Humble
// files: alphanumerics, dot, underscore, hyphen — no path separators.
const OP_FILE_RE = /^[a-zA-Z0-9._-]+\.json$/;

function handleOpDetail(xmRoot, file, req) {
  const fileName = file.endsWith('.json') ? file : file + '.json';
  if (!OP_FILE_RE.test(fileName)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const filePath = safeJoin(xmRoot, 'op', fileName);
  if (!filePath || !existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return jsonResponseWithETag(data, req);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error' }, req, 500);
  }
}

function handleSolverList(xmRoot, req) {
  const solverDir = safeJoin(xmRoot, 'solver', 'problems');
  if (!solverDir || !existsSync(solverDir)) return jsonResponseWithETag({ data: [] }, req);
  const manifests = [];
  for (const entry of readdirSync(solverDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = safeJoin(solverDir, entry.name, 'manifest.json');
    if (!manifestPath || !existsSync(manifestPath)) continue;
    try {
      manifests.push(JSON.parse(readFileSync(manifestPath, 'utf8')));
    } catch {}
  }
  return jsonResponseWithETag({ data: manifests }, req);
}

function handleSolverDetail(xmRoot, slug, req) {
  if (!isValidSegment(slug)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const problemDir = safeJoin(xmRoot, 'solver', 'problems', slug);
  if (!problemDir || !existsSync(problemDir)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);

  const manifestPath = safeJoin(problemDir, 'manifest.json');
  if (!manifestPath || !existsSync(manifestPath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file: 'manifest.json' }, req, 500);
  }

  const phases = [];
  const phasesDir = safeJoin(problemDir, 'phases');
  if (phasesDir && existsSync(phasesDir)) {
    for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const phaseDir = safeJoin(phasesDir, entry.name);
      if (!phaseDir) continue;
      const phaseData = { phase: entry.name, files: {} };
      for (const file of readdirSync(phaseDir)) {
        const filePath = safeJoin(phaseDir, file);
        if (!filePath) continue;
        try {
          const content = readFileSync(filePath, 'utf8');
          if (file.endsWith('.json')) {
            phaseData.files[file] = JSON.parse(content);
          } else {
            phaseData.files[file] = content;
          }
        } catch {}
      }
      if (Object.keys(phaseData.files).length > 0) {
        phases.push(phaseData);
      }
    }
  }

  return jsonResponseWithETag({ manifest, phases }, req);
}

// ── x-review handlers ──────────────────────────────────────────────

function handleReviewLast(xmRoot, req) {
  const reviewDir = safeJoin(xmRoot, 'review');
  if (!reviewDir) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);

  const result = { json: null, md: null };

  const jsonPath = safeJoin(reviewDir, 'last-result.json');
  if (jsonPath && existsSync(jsonPath)) {
    try { result.json = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch {}
  }
  const mdPath = safeJoin(reviewDir, 'last-result.md');
  if (mdPath && existsSync(mdPath)) {
    try { result.md = readFileSync(mdPath, 'utf8'); } catch {}
  }

  if (!result.json && !result.md) {
    return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  }
  return jsonResponseWithETag(result, req);
}

function handleReviewHistory(xmRoot, req) {
  const historyDir = safeJoin(xmRoot, 'review', 'history');
  if (!historyDir || !existsSync(historyDir)) return jsonResponseWithETag({ data: [] }, req);

  const results = [];
  for (const entry of readdirSync(historyDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = safeJoin(historyDir, entry.name);
    if (!filePath) continue;
    try {
      const content = readFileSync(filePath, 'utf8');
      // Parse MD header block produced by x-review
      const titleMatch = content.match(/^# x-review: (.+?) — (.+)$/m);
      const dateMatch = content.match(/^- Date: (.+)$/m);
      const branchMatch = content.match(/^- Branch: (.+)$/m);
      const lensesMatch = content.match(/^- Lenses: (.+)$/m);
      const findingsMatch = content.match(/^- Findings: (.+)$/m);
      results.push({
        file: entry.name,
        target: titleMatch?.[1] ?? entry.name,
        verdict: titleMatch?.[2] ?? 'unknown',
        date: dateMatch?.[1] ?? '',
        branch: branchMatch?.[1] ?? '',
        lenses: lensesMatch?.[1] ?? '',
        findings_summary: findingsMatch?.[1] ?? '',
      });
    } catch {}
  }
  results.sort((a, b) => (b.date || b.file).localeCompare(a.date || a.file));
  return jsonResponseWithETag({ data: results }, req);
}

function handleReviewHistoryFile(xmRoot, file, req) {
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(file)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const filePath = safeJoin(xmRoot, 'review', 'history', file);
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  try {
    return jsonResponseWithETag({ file, content: readFileSync(filePath, 'utf8') }, req);
  } catch {
    return jsonResponseWithETag({ error: 'read_error' }, req, 500);
  }
}

// ── x-eval handlers ────────────────────────────────────────────────

const EVAL_CATEGORIES = new Set(['results', 'benchmarks', 'diffs', 'rubrics']);

function handleEvalList(xmRoot, req) {
  const evalDir = safeJoin(xmRoot, 'eval');
  const categories = { results: [], benchmarks: [], diffs: [], rubrics: [] };
  if (!evalDir || !existsSync(evalDir)) return jsonResponseWithETag({ categories }, req);

  for (const cat of EVAL_CATEGORIES) {
    const catDir = safeJoin(evalDir, cat);
    if (!catDir || !existsSync(catDir)) continue;
    const items = [];
    try {
      for (const entry of readdirSync(catDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = safeJoin(catDir, entry.name);
        if (!filePath) continue;
        let summary = null;
        let timestamp = null;
        if (entry.name.endsWith('.json')) {
          try {
            const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
            timestamp = parsed.timestamp ?? parsed.created_at ?? parsed.completed_at ?? parsed.date ?? null;
            summary = {
              type: parsed.type ?? null,
              rubric: parsed.rubric ?? null,
              overall: parsed.overall ?? parsed.score ?? parsed.total_score ?? null,
              verdict: parsed.verdict ?? null,
              from: parsed.from ?? null,
              to: parsed.to ?? null,
              name: parsed.name ?? null,
            };
          } catch {}
        }
        items.push({ file: entry.name, timestamp, summary });
      }
    } catch {}
    items.sort((a, b) => (b.timestamp || b.file).localeCompare(a.timestamp || a.file));
    categories[cat] = items;
  }
  return jsonResponseWithETag({ categories }, req);
}

function handleEvalFile(xmRoot, category, file, req) {
  if (!EVAL_CATEGORIES.has(category)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!/^[a-zA-Z0-9._-]+\.(json|md)$/.test(file)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const filePath = safeJoin(xmRoot, 'eval', category, file);
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (file.endsWith('.json')) {
      return jsonResponseWithETag({ category, file, json: JSON.parse(raw) }, req);
    }
    return jsonResponseWithETag({ category, file, content: raw }, req);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file }, req, 500);
  }
}

// ── x-humble handlers ──────────────────────────────────────────────

const HUMBLE_KINDS = new Set(['lessons', 'retrospectives']);

function handleHumbleList(xmRoot, req) {
  const humbleDir = safeJoin(xmRoot, 'humble');
  const kinds = { lessons: [], retrospectives: [] };
  if (!humbleDir || !existsSync(humbleDir)) return jsonResponseWithETag({ kinds }, req);

  for (const kind of HUMBLE_KINDS) {
    const kindDir = safeJoin(humbleDir, kind);
    if (!kindDir || !existsSync(kindDir)) continue;
    const items = [];
    try {
      for (const entry of readdirSync(kindDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const filePath = safeJoin(kindDir, entry.name);
        if (!filePath) continue;
        let summary = null;
        let timestamp = null;
        if (entry.name.endsWith('.json')) {
          try {
            const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
            timestamp = parsed.timestamp ?? parsed.created_at ?? parsed.updated_at ?? null;
            summary = {
              title: parsed.title ?? null,
              type: parsed.type ?? null,
              status: parsed.status ?? null,
              confirmed_count: parsed.confirmed_count ?? null,
              tags: Array.isArray(parsed.tags) ? parsed.tags : null,
              // Sankey link fields — included for humble graph rendering
              applied_to_claudemd: parsed.applied_to_claudemd ?? null,
              source_retrospective: parsed.source_retrospective ?? null,
              lessons_created: Array.isArray(parsed.lessons_created) ? parsed.lessons_created : null,
              failures_identified: Array.isArray(parsed.failures_identified) ? parsed.failures_identified : null,
              id: parsed.id ?? null,
            };
          } catch {}
        } else if (entry.name.endsWith('.md')) {
          try {
            const content = readFileSync(filePath, 'utf8').slice(0, 800);
            const titleMatch = content.match(/^#\s+(.+)$/m);
            const dateMatch = content.match(/^- Date: (.+)$/m);
            timestamp = dateMatch?.[1] ?? null;
            summary = { title: titleMatch?.[1] ?? null };
          } catch {}
        }
        items.push({ file: entry.name, timestamp, summary });
      }
    } catch {}
    items.sort((a, b) => (b.timestamp || b.file).localeCompare(a.timestamp || a.file));
    kinds[kind] = items;
  }
  return jsonResponseWithETag({ kinds }, req);
}

function handleHumbleFile(xmRoot, kind, file, req) {
  if (!HUMBLE_KINDS.has(kind)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!/^[a-zA-Z0-9._-]+\.(json|md)$/.test(file)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const filePath = safeJoin(xmRoot, 'humble', kind, file);
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (file.endsWith('.json')) {
      return jsonResponseWithETag({ kind, file, json: JSON.parse(raw) }, req);
    }
    return jsonResponseWithETag({ kind, file, content: raw }, req);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file }, req, 500);
  }
}

/**
 * PATCH a humble lesson JSON. Only allow-listed fields may be written —
 * arbitrary JSON mutation is refused to prevent corruption of other
 * plugins' state.
 */
const LESSON_PATCHABLE = new Set(['applied_to_claudemd', 'status']);

async function handleHumbleLessonPatch(xmRoot, file, req) {
  if (!/^[a-zA-Z0-9._-]+\.json$/.test(file)) {
    return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  }
  const filePath = safeJoin(xmRoot, 'humble', 'lessons', file);
  if (!filePath || !existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);

  let body;
  try { body = await req.json(); }
  catch { return jsonResponseWithETag({ error: 'invalid_json' }, req, 400); }

  const patch = body && typeof body === 'object' ? body : {};
  const disallowed = Object.keys(patch).filter(k => !LESSON_PATCHABLE.has(k));
  if (disallowed.length) {
    return jsonResponseWithETag({
      error: 'disallowed_fields',
      fields: disallowed,
      allowed: [...LESSON_PATCHABLE],
    }, req, 400);
  }

  let current;
  try { current = JSON.parse(readFileSync(filePath, 'utf8')); }
  catch { return jsonResponseWithETag({ error: 'parse_error' }, req, 500); }

  const before = { ...current };
  const next = { ...current, ...patch, last_confirmed: new Date().toISOString() };
  writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n');

  return jsonResponseWithETag({
    ok: true,
    file,
    patched: Object.keys(patch),
    before: Object.fromEntries(Object.keys(patch).map(k => [k, before[k]])),
    after: Object.fromEntries(Object.keys(patch).map(k => [k, next[k]])),
  }, req);
}

function handleSearch(xmRoot, url, req) {
  const q = (url.searchParams.get('q') ?? '').trim();
  if (!q) return jsonResponseWithETag({ data: [] }, req);

  const qLower = q.toLowerCase();
  const results = [];

  function snippet(text, keyword) {
    const idx = text.toLowerCase().indexOf(keyword);
    if (idx === -1) return null;
    const start = Math.max(0, idx - 25);
    const end = Math.min(text.length, idx + keyword.length + 25);
    let s = text.slice(start, end);
    if (start > 0) s = '…' + s;
    if (end < text.length) s = s + '…';
    return s;
  }

  function matchesAny(strings, kw) {
    return strings.some(s => s && s.toLowerCase().includes(kw));
  }

  // Search projects
  const projectsDir = safeJoin(xmRoot, 'build', 'projects');
  if (projectsDir && existsSync(projectsDir)) {
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectSlug = entry.name;
      const projectDir = safeJoin(projectsDir, projectSlug);
      if (!projectDir) continue;

      // manifest.json — project name + display_name
      const manifestPath = safeJoin(projectDir, 'manifest.json');
      if (manifestPath && existsSync(manifestPath)) {
        try {
          const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
          const fields = [m.name, m.display_name, m.description].filter(Boolean);
          if (matchesAny(fields, qLower)) {
            const matchField = fields.find(f => f && f.toLowerCase().includes(qLower)) ?? '';
            results.push({
              type: 'project',
              name: m.display_name || m.name || projectSlug,
              match: snippet(matchField, qLower) ?? matchField.slice(0, 80),
              url: `#/projects/${projectSlug}`,
            });
          }
        } catch {}
      }

      // tasks.json — task names
      const tasksPath = safeJoin(projectDir, 'phases', '02-plan', 'tasks.json');
      if (tasksPath && existsSync(tasksPath)) {
        try {
          const tasksData = JSON.parse(readFileSync(tasksPath, 'utf8'));
          const tasks = Array.isArray(tasksData) ? tasksData
            : Array.isArray(tasksData?.tasks) ? tasksData.tasks
            : Array.isArray(tasksData?.data) ? tasksData.data : [];
          for (const task of tasks) {
            const fields = [task.name, task.id, task.done_criteria].filter(Boolean);
            if (matchesAny(fields, qLower)) {
              const matchField = fields.find(f => f && f.toLowerCase().includes(qLower)) ?? '';
              results.push({
                type: 'task',
                name: task.name || task.id || '—',
                project: projectSlug,
                match: snippet(matchField, qLower) ?? matchField.slice(0, 80),
                url: `#/projects/${projectSlug}`,
              });
            }
          }
        } catch {}
      }

      // context/*.md — doc content
      const contextDir = safeJoin(projectDir, 'context');
      if (contextDir && existsSync(contextDir)) {
        for (const mdEntry of readdirSync(contextDir, { withFileTypes: true })) {
          if (!mdEntry.isFile() || !mdEntry.name.endsWith('.md')) continue;
          const mdPath = safeJoin(contextDir, mdEntry.name);
          if (!mdPath) continue;
          try {
            const content = readFileSync(mdPath, 'utf8');
            if (content.toLowerCase().includes(qLower)) {
              results.push({
                type: 'doc',
                name: mdEntry.name,
                project: projectSlug,
                match: snippet(content, qLower) ?? content.slice(0, 80),
                url: `#/projects/${projectSlug}`,
              });
            }
          } catch {}
        }
      }
    }
  }

  // Search probes — last-verdict.json + history/*.json
  const probeFiles = [];
  const lastVerdictPath = safeJoin(xmRoot, 'probe', 'last-verdict.json');
  if (lastVerdictPath && existsSync(lastVerdictPath)) {
    probeFiles.push({ path: lastVerdictPath, file: 'latest' });
  }
  const probeHistoryDir = safeJoin(xmRoot, 'probe', 'history');
  if (probeHistoryDir && existsSync(probeHistoryDir)) {
    for (const entry of readdirSync(probeHistoryDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const fp = safeJoin(probeHistoryDir, entry.name);
      if (fp) probeFiles.push({ path: fp, file: entry.name });
    }
  }
  for (const { path: fp, file } of probeFiles) {
    try {
      const p = JSON.parse(readFileSync(fp, 'utf8'));
      const fields = [p.idea, p.recommendation, ...(Array.isArray(p.premises) ? p.premises.map(pr => pr.statement) : [])].filter(Boolean);
      if (matchesAny(fields, qLower)) {
        const matchField = fields.find(f => f && f.toLowerCase().includes(qLower)) ?? '';
        results.push({
          type: 'probe',
          name: p.idea || file,
          match: snippet(matchField, qLower) ?? matchField.slice(0, 80),
          url: `#/probes/${encodeURIComponent(file)}`,
        });
      }
    } catch {}
  }

  // Search solvers — solver/problems/*/manifest.json
  const solverDir = safeJoin(xmRoot, 'solver', 'problems');
  if (solverDir && existsSync(solverDir)) {
    for (const entry of readdirSync(solverDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = safeJoin(solverDir, entry.name, 'manifest.json');
      if (!manifestPath || !existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const fields = [m.name, m.display_name, m.problem].filter(Boolean);
        if (matchesAny(fields, qLower)) {
          const matchField = fields.find(f => f && f.toLowerCase().includes(qLower)) ?? '';
          results.push({
            type: 'solver',
            name: m.display_name || m.name || entry.name,
            match: snippet(matchField, qLower) ?? matchField.slice(0, 80),
            url: `#/solvers/${entry.name}`,
          });
        }
      } catch {}
    }
  }

  return jsonResponseWithETag({ data: results }, req);
}

// ── R3: Traces API ────────────────────────────────────────────────────

const MODEL_PRICING = {
  haiku:  { input: 0.80 / 1_000_000, output: 4.00 / 1_000_000 },
  sonnet: { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  opus:   { input: 15.00 / 1_000_000, output: 75.00 / 1_000_000 },
};

function resolveModelKey(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('haiku'))  return 'haiku';
  if (m.includes('opus'))   return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  return null;
}

function parseJsonlFile(filePath) {
  try {
    return readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function handleTraces(xmRoot, req) {
  const tracesDir = safeJoin(xmRoot, 'traces');

  // Read active pointer
  let active = null;
  const activeFile = tracesDir ? safeJoin(xmRoot, 'traces', '.active') : null;
  if (activeFile && existsSync(activeFile)) {
    try { active = readFileSync(activeFile, 'utf8').trim(); } catch {}
  }

  if (!tracesDir || !existsSync(tracesDir)) {
    return jsonResponseWithETag({ traces: [], active }, req);
  }

  let entries;
  try {
    entries = readdirSync(tracesDir, { withFileTypes: true });
  } catch {
    return jsonResponseWithETag({ traces: [], active }, req);
  }

  const traces = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = safeJoin(tracesDir, entry.name);
    if (!filePath) continue;

    // Read the file once; reuse for line-count/first-last and cost calc.
    // parseJsonlFile catches read errors internally and returns []; treat that
    // the same as an empty file (entry included with lineCount=0) to preserve
    // the original behaviour for empty files while avoiding a double-read.
    const parsedLines = parseJsonlFile(filePath);

    const lineCount = parsedLines.length;
    const firstEntry = parsedLines[0] ?? null;
    const lastEntry = parsedLines[parsedLines.length - 1] ?? null;

    // Parse name and date from filename: {name}-{YYYYMMDD-HHMMSS}.jsonl
    const nameMatch = entry.name.match(/^(.+)-(\d{8}-\d{6})\.jsonl$/);
    const name = nameMatch ? nameMatch[1] : entry.name.replace(/\.jsonl$/, '');
    const dateStr = nameMatch ? nameMatch[2].slice(0, 4) + '-' + nameMatch[2].slice(4, 6) + '-' + nameMatch[2].slice(6, 8) : null;

    const startTime = firstEntry?.timestamp ?? null;
    let duration = null;
    let status = 'active';
    if (lastEntry && lastEntry.type === 'session_end') {
      status = 'completed';
      if (firstEntry?.timestamp && lastEntry?.timestamp) {
        duration = new Date(lastEntry.timestamp) - new Date(firstEntry.timestamp);
      }
      if (duration == null && lastEntry?.duration_ms != null) {
        duration = lastEntry.duration_ms;
      }
    }

    // Calculate per-trace cost from agent_call/agent_step entries (reuse parsed array)
    let traceCost = 0;
    let traceTokensIn = 0;
    let traceTokensOut = 0;
    let agentCount = 0;
    for (const ln of parsedLines) {
      if (ln.type !== 'agent_call' && ln.type !== 'agent_step') continue;
      agentCount++;
      const inTok = ln.input_tokens_est ?? ln.tokens_est?.input ?? 0;
      const outTok = ln.output_tokens_est ?? ln.tokens_est?.output ?? 0;
      traceTokensIn += inTok;
      traceTokensOut += outTok;
      const mk = resolveModelKey(ln.agent?.model ?? ln.model);
      const pr = mk ? MODEL_PRICING[mk] : null;
      if (pr) traceCost += inTok * pr.input + outTok * pr.output;
    }

    traces.push({
      file: entry.name,
      name,
      date: dateStr,
      entryCount: lineCount,
      duration,
      status,
      startTime,
      cost: traceCost,
      tokens: { input: traceTokensIn, output: traceTokensOut },
      agents: agentCount,
    });
  }

  // Sort newest first
  traces.sort((a, b) => (b.startTime ?? '') < (a.startTime ?? '') ? -1 : 1);

  return jsonResponseWithETag({ traces, active }, req);
}

function handleTraceDetail(xmRoot, file, req, url) {
  // Allow filenames like name-20260403-120000.jsonl or name-20260403-120000-a3f1.jsonl
  const TRACE_FILE_RE = /^[a-zA-Z0-9._-]+-\d{8}-\d{6}(-[a-f0-9]{4})?\.jsonl$/;
  if (!TRACE_FILE_RE.test(file)) {
    return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  }

  const filePath = safeJoin(xmRoot, 'traces', file);
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);

  const limit = Math.max(1, parseInt(url.searchParams.get('limit') ?? '200', 10));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));

  const entries = parseJsonlFile(filePath);
  const total = entries.length;
  return jsonResponseWithETag({
    entries: entries.slice(offset, offset + limit),
    total,
    limit,
    offset,
    file,
  }, req);
}

// ── R5: Costs API ─────────────────────────────────────────────────────

function handleCosts(xmRoot, req) {
  const tracesDir = safeJoin(xmRoot, 'traces');
  if (!tracesDir || !existsSync(tracesDir)) {
    return jsonResponseWithETag({
      totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0,
      byModel: {}, byDate: [],
    }, req);
  }

  let entries;
  try {
    entries = readdirSync(tracesDir, { withFileTypes: true });
  } catch {
    return jsonResponseWithETag({
      totalCost: 0, totalInputTokens: 0, totalOutputTokens: 0,
      byModel: {}, byDate: [],
    }, req);
  }

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const byModel = {};
  const byDateMap = {};

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const filePath = safeJoin(tracesDir, entry.name);
    if (!filePath) continue;

    const lines = parseJsonlFile(filePath);
    for (const line of lines) {
      if (line.type !== 'agent_call' && line.type !== 'agent_step') continue;
      const inputTokens = line.input_tokens_est ?? line.tokens_est?.input ?? 0;
      const outputTokens = line.output_tokens_est ?? line.tokens_est?.output ?? 0;
      if (!inputTokens && !outputTokens) continue;

      const modelKey = resolveModelKey(line.agent?.model ?? line.model);
      const pricing = modelKey ? MODEL_PRICING[modelKey] : null;
      const cost = pricing
        ? inputTokens * pricing.input + outputTokens * pricing.output
        : 0;

      totalCost += cost;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      if (modelKey) {
        if (!byModel[modelKey]) byModel[modelKey] = { cost: 0, inputTokens: 0, outputTokens: 0 };
        byModel[modelKey].cost += cost;
        byModel[modelKey].inputTokens += inputTokens;
        byModel[modelKey].outputTokens += outputTokens;
      }

      // Date from timestamp
      const ts = line.timestamp;
      if (ts) {
        const date = ts.slice(0, 10); // YYYY-MM-DD
        if (!byDateMap[date]) byDateMap[date] = { date, cost: 0, inputTokens: 0, outputTokens: 0 };
        byDateMap[date].cost += cost;
        byDateMap[date].inputTokens += inputTokens;
        byDateMap[date].outputTokens += outputTokens;
      }
    }
  }

  const byDate = Object.values(byDateMap).sort((a, b) => a.date < b.date ? -1 : 1);

  return jsonResponseWithETag({
    totalCost, totalInputTokens, totalOutputTokens, byModel, byDate,
  }, req);
}

function handleMetricsSessions(xmRoot, url, req) {
  const limit = Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));
  const filePath = safeJoin(xmRoot, 'build', 'metrics', 'sessions.jsonl');
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ data: [], total: 0 }, req);
  const parsed = parseJsonlFile(filePath);
  const total = parsed.length;
  return jsonResponseWithETag({ data: parsed.slice(offset, offset + limit), total, limit, offset }, req);
}

function handleMemoryList(xmRoot, url, req) {
  const indexPath = safeJoin(xmRoot, 'memory', 'index.json');
  if (!indexPath || !existsSync(indexPath)) {
    return jsonResponseWithETag({ decisions: [], total: 0 }, req);
  }
  let entries;
  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf8'));
    entries = Array.isArray(raw) ? raw : (Array.isArray(raw.decisions) ? raw.decisions : []);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file: 'index.json' }, req, 500);
  }

  const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const typeFilter = (url.searchParams.get('type') ?? '').trim().toLowerCase();

  let result = entries;
  if (q) {
    result = result.filter(e => {
      const title = (e.title ?? '').toLowerCase();
      const why = (e.why ?? '').toLowerCase();
      const tags = Array.isArray(e.tags) ? e.tags.join(' ').toLowerCase() : '';
      return title.includes(q) || why.includes(q) || tags.includes(q);
    });
  }
  if (typeFilter) {
    result = result.filter(e => (e.type ?? '').toLowerCase() === typeFilter);
  }

  return jsonResponseWithETag({ decisions: result, total: result.length }, req);
}

function handleMemoryDetail(xmRoot, id, req) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  }
  const mdPath = safeJoin(xmRoot, 'memory', 'memories', id + '.md');
  if (!mdPath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(mdPath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);

  let content;
  try {
    content = readFileSync(mdPath, 'utf8');
  } catch {
    return jsonResponseWithETag({ error: 'read_error' }, req, 500);
  }

  let meta = null;
  const resolvedIndex = safeJoin(xmRoot, 'memory', 'index.json');
  if (resolvedIndex && existsSync(resolvedIndex)) {
    try {
      const raw = JSON.parse(readFileSync(resolvedIndex, 'utf8'));
      const idx = Array.isArray(raw) ? raw : (Array.isArray(raw.decisions) ? raw.decisions : []);
      meta = idx.find(e => e.id === id) ?? null;
    } catch {}
  }

  return jsonResponseWithETag({ id, content, meta }, req);
}

// ── M4: WorkspaceAPI helpers ─────────────────────────────────────────

/** TTL cache for getWorkspaceStats — keyed by ws.id, 10 s window */
const _wsStatsCache = new Map(); // id → { ts: number, value: object }
const WS_STATS_TTL_MS = 10_000;

function countDirEntries(dirPath) {
  if (!dirPath || !existsSync(dirPath)) return 0;
  try {
    return readdirSync(dirPath).length;
  } catch {
    return 0;
  }
}

function getWorkspaceStats(ws) {
  // TTL cache: reuse computed stats for the same workspace within 10 s
  const now = Date.now();
  const cached = _wsStatsCache.get(ws.id);
  if (cached && now - cached.ts < WS_STATS_TTL_MS) return cached.value;

  const projectsDir = safeJoin(ws.xmRoot, 'build', 'projects');
  const probeHistoryDir = safeJoin(ws.xmRoot, 'probe', 'history');
  const solverDir = safeJoin(ws.xmRoot, 'solver', 'problems');

  // Calculate total cost from traces
  let totalCost = 0;
  const tracesDir = safeJoin(ws.xmRoot, 'traces');
  if (tracesDir && existsSync(tracesDir)) {
    try {
      for (const entry of readdirSync(tracesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const fp = safeJoin(tracesDir, entry.name);
        if (!fp) continue;
        for (const ln of parseJsonlFile(fp)) {
          if (ln.type !== 'agent_call' && ln.type !== 'agent_step') continue;
          const inTok = ln.input_tokens_est ?? ln.tokens_est?.input ?? 0;
          const outTok = ln.output_tokens_est ?? ln.tokens_est?.output ?? 0;
          const mk = resolveModelKey(ln.agent?.model ?? ln.model);
          const pr = mk ? MODEL_PRICING[mk] : null;
          if (pr) totalCost += inTok * pr.input + outTok * pr.output;
        }
      }
    } catch {}
  }

  const value = {
    projects: countDirEntries(projectsDir),
    probes: countDirEntries(probeHistoryDir),
    solvers: countDirEntries(solverDir),
    cost: Math.round(totalCost * 1000) / 1000,
  };
  _wsStatsCache.set(ws.id, { ts: now, value });
  return value;
}

// ── Build-id Mode (early exit — print the served bundle's identity) ──
// Used by the release gate to compute the source tree's buildId and compare
// it against a running server's /health buildId without starting a server.

if (BUILD_ID_MODE) {
  console.log(JSON.stringify({ buildId: BUILD.buildId, servedFrom: PUBLIC_DIR, version: VERSION, assets: BUILD.assets }));
  process.exit(0);
}

// ── Stop Mode (early exit — must run before server starts) ───────────

if (STOP_MODE) {
  // Resolve target PID. Prefer the PID file, but fall back to lsof so we
  // can still stop an orphaned dashboard that lost its PID file.
  let pid = null;
  let port = PORT;
  let source = 'pid-file';

  if (existsSync(PID_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(PID_FILE, 'utf8'));
      if (existing?.pid) {
        pid = existing.pid;
        port = existing.port ?? PORT;
      }
    } catch {
      console.error('[x-dashboard-server] PID file unreadable — falling back to port probe');
    }
  }

  if (!pid) {
    const holder = findPortHolder(PORT);
    if (holder) {
      pid = Number(holder.pid);
      source = `port ${PORT} probe (lsof)`;
    }
  }

  if (!pid) {
    console.log('[x-dashboard-server] Not running (no PID file, port idle)');
    process.exit(0);
  }

  // Check if alive
  try {
    process.kill(pid, 0);
  } catch {
    console.log(`[x-dashboard-server] Process ${pid} is not running (stale)`);
    try { unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  }

  console.log(`[x-dashboard-server] Stopping pid ${pid} (port ${port}, source: ${source})...`);
  process.kill(pid, 'SIGTERM');

  // Wait up to 5s for the process to exit
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      // Process gone — clean up stale PID file if the dying process didn't
      try { unlinkSync(PID_FILE); } catch {}
      console.log('[x-dashboard-server] Stopped.');
      process.exit(0);
    }
    const wait = Date.now() + 100;
    while (Date.now() < wait) {}
  }

  console.error(`[x-dashboard-server] Process ${pid} did not exit within 5s — sending SIGKILL`);
  try { process.kill(pid, 'SIGKILL'); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(1);
}

// ── Pre-start checks ─────────────────────────────────────────────────

checkDuplicateInstance();

// ── HTTP Server ─────────────────────────────────────────────────────

let server;
server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',

  async fetch(req) {
    resetIdleTimer();
    const url = new URL(req.url);
    const path = url.pathname;

    // ── /health ──────────────────────────────────────────────────
    if (path === '/health') {
      return Response.json({
        status: 'ok',
        version: VERSION,
        buildId: BUILD.buildId,
        servedFrom: PUBLIC_DIR,
        assets: BUILD.assets,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        port: PORT,
        pid: process.pid,
      });
    }

    // ── /api/health ──────────────────────────────────────────────
    if (path === '/api/health') {
      const cwd = process.cwd();
      const projectName = cwd.split('/').pop();
      return Response.json({
        status: 'ok',
        version: VERSION,
        buildId: BUILD.buildId,
        servedFrom: PUBLIC_DIR,
        assets: BUILD.assets,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        port: PORT,
        pid: process.pid,
        mode: SESSION_MODE ? 'session' : 'standalone',
        cwd,
        project: projectName,
        xmRoot: XM_ROOT,
        workspaces: workspaces.length,
        multiRoot: !!SCAN_DIR || workspaces.length > 1,
      });
    }

    // ── /shutdown ────────────────────────────────────────────────
    if (path === '/shutdown') {
      setTimeout(() => shutdown(), 100);
      return Response.json({ status: 'shutting_down' });
    }

    // ── POST /api/rescan — Re-scan workspaces (all modes) ──────
    // Use from `xm project add` to hot-reload registry changes without
    // restarting the server.
    if (req.method === 'POST' && path === '/api/rescan') {
      const before = workspaces.length;
      const result = rebuildWorkspaces();
      // Reset mtime marker so the interval watcher doesn't fire again for
      // the same change we just picked up manually.
      try { lastRegistryMtime = statSync(REGISTRY_PATH).mtimeMs; } catch {}
      return Response.json({
        workspaces: result.count,
        source: result.source,
        changed: result.count !== before,
        before,
      });
    }

    // ── JSON API ─────────────────────────────────────────────────
    // ── PATCH /api/ws/:wsId/humble/lessons/:file ──────────────
    // Allow-listed field mutation for Humble lessons.
    if (req.method === 'PATCH' && path.startsWith('/api/')) {
      const wsLessonMatch = path.match(/^\/api\/ws\/([^/]+)\/humble\/lessons\/([^/]+)$/);
      if (wsLessonMatch) {
        const wsId = decodeURIComponent(wsLessonMatch[1]);
        const file = decodeURIComponent(wsLessonMatch[2]);
        const xmRoot = resolveXmRoot(wsId);
        if (!xmRoot) return Response.json({ error: 'workspace_not_found' }, { status: 404 });
        return handleHumbleLessonPatch(xmRoot, file, req);
      }
      const lessonMatch = path.match(/^\/api\/humble\/lessons\/([^/]+)$/);
      if (lessonMatch) {
        const file = decodeURIComponent(lessonMatch[1]);
        return handleHumbleLessonPatch(XM_ROOT, file, req);
      }
      // PATCH /api/ws/:wsId/config  +  PATCH /api/config
      const wsConfigMatch = path.match(/^\/api\/ws\/([^/]+)\/config$/);
      if (wsConfigMatch) {
        const xmRoot = resolveXmRoot(decodeURIComponent(wsConfigMatch[1]));
        if (!xmRoot) return Response.json({ error: 'workspace_not_found' }, { status: 404 });
        return handleConfigPatch(xmRoot, req);
      }
      if (path === '/api/config') {
        return handleConfigPatch(XM_ROOT, req);
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    if (req.method === 'GET' && path.startsWith('/api/')) {

      // ── M4: GET /api/workspaces ──────────────────────────────
      if (path === '/api/workspaces') {
        const childCounts = new Map();
        for (const ws of workspaces) {
          if (ws.parentId) childCounts.set(ws.parentId, (childCounts.get(ws.parentId) ?? 0) + 1);
        }
        const data = workspaces.map(ws => ({
          id: ws.id,
          name: ws.name,
          path: ws.path,
          parentId: ws.parentId ?? null,
          childCount: childCounts.get(ws.id) ?? 0,
          stats: getWorkspaceStats(ws),
        }));
        return jsonResponseWithETag(data, req);
      }

      // ── M4: GET /api/workspaces/:wsId ────────────────────────
      const workspaceDetailMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
      if (workspaceDetailMatch) {
        const wsId = decodeURIComponent(workspaceDetailMatch[1]);
        const ws = getWorkspace(wsId);
        if (!ws) return jsonResponseWithETag({ error: 'workspace_not_found' }, req, 404);
        return jsonResponseWithETag({
          id: ws.id,
          name: ws.name,
          path: ws.path,
          xmRoot: ws.xmRoot,
          parentId: ws.parentId ?? null,
          stats: getWorkspaceStats(ws),
        }, req);
      }

      // ── M3: Scoped routes /api/ws/:wsId/... ──────────────────
      const wsPrefix = path.match(/^\/api\/ws\/([^/]+)(\/.*)?$/);
      if (wsPrefix) {
        const wsId = decodeURIComponent(wsPrefix[1]);
        const subPath = wsPrefix[2] ?? '/';
        const xmRoot = resolveXmRoot(wsId);
        if (!xmRoot) return jsonResponseWithETag({ error: 'workspace_not_found' }, req, 404);

        // GET /api/ws/:wsId/config
        if (subPath === '/config') {
          return handleConfig(xmRoot, req);
        }

        // GET /api/ws/:wsId/config/model-routing
        if (subPath === '/config/model-routing') {
          return handleModelRouting(xmRoot, req);
        }

        // GET /api/ws/:wsId/projects
        if (subPath === '/projects') {
          return handleProjects(xmRoot, req);
        }

        // GET /api/ws/:wsId/later
        if (subPath === '/later') {
          return handleLaterAll(xmRoot, req);
        }

        // GET /api/ws/:wsId/projects/:slug/tasks
        const wsTasksMatch = subPath.match(/^\/projects\/([^/]+)\/tasks$/);
        if (wsTasksMatch) {
          const slug = decodeURIComponent(wsTasksMatch[1]);
          return handleProjectTasks(xmRoot, slug, req);
        }

        // GET /api/ws/:wsId/projects/:slug/later
        const wsLaterMatch = subPath.match(/^\/projects\/([^/]+)\/later$/);
        if (wsLaterMatch) {
          const slug = decodeURIComponent(wsLaterMatch[1]);
          return handleProjectLater(xmRoot, slug, req);
        }

        // GET /api/ws/:wsId/projects/:slug/gate
        const wsGateMatch = subPath.match(/^\/projects\/([^/]+)\/gate$/);
        if (wsGateMatch) {
          const slug = decodeURIComponent(wsGateMatch[1]);
          return handleProjectGate(xmRoot, slug, req);
        }

        // GET /api/ws/:wsId/projects/:slug
        const wsProjectMatch = subPath.match(/^\/projects\/([^/]+)$/);
        if (wsProjectMatch) {
          const slug = decodeURIComponent(wsProjectMatch[1]);
          return handleProjectDetail(xmRoot, slug, req);
        }

        // GET /api/ws/:wsId/probe/latest
        if (subPath === '/probe/latest') {
          return handleProbeLatest(xmRoot, req);
        }

        // GET /api/ws/:wsId/probe/diff?a=<file>&b=<file>
        if (subPath === '/probe/diff') {
          return handleProbeDiff(xmRoot, url, req);
        }

        // GET /api/ws/:wsId/probe/history/:file
        const wsProbeFileMatch = subPath.match(/^\/probe\/history\/([^/]+)$/);
        if (wsProbeFileMatch) {
          const file = decodeURIComponent(wsProbeFileMatch[1]);
          return handleProbeHistoryFile(xmRoot, file, req);
        }

        // GET /api/ws/:wsId/probe/history
        if (subPath === '/probe/history') {
          return handleProbeHistory(xmRoot, req);
        }

        // GET /api/ws/:wsId/op
        if (subPath === '/op') {
          return handleOpList(xmRoot, req);
        }

        // GET /api/ws/:wsId/op/:file
        const wsOpMatch = subPath.match(/^\/op\/([^/]+)$/);
        if (wsOpMatch) {
          const file = decodeURIComponent(wsOpMatch[1]);
          return handleOpDetail(xmRoot, file, req);
        }

        // GET /api/ws/:wsId/solver
        if (subPath === '/solver') {
          return handleSolverList(xmRoot, req);
        }

        // GET /api/ws/:wsId/solver/:slug
        const wsSolverMatch = subPath.match(/^\/solver\/([^/]+)$/);
        if (wsSolverMatch) {
          const slug = decodeURIComponent(wsSolverMatch[1]);
          return handleSolverDetail(xmRoot, slug, req);
        }

        // GET /api/ws/:wsId/search
        if (subPath === '/search') {
          return handleSearch(xmRoot, url, req);
        }

        // GET /api/ws/:wsId/metrics/sessions
        if (subPath === '/metrics/sessions') {
          return handleMetricsSessions(xmRoot, url, req);
        }

        // GET /api/ws/:wsId/traces
        if (subPath === '/traces') {
          return handleTraces(xmRoot, req);
        }

        // GET /api/ws/:wsId/traces/:file
        const wsTraceFileMatch = subPath.match(/^\/traces\/([^/]+)$/);
        if (wsTraceFileMatch) {
          const file = decodeURIComponent(wsTraceFileMatch[1]);
          return handleTraceDetail(xmRoot, file, req, url);
        }

        // GET /api/ws/:wsId/costs
        if (subPath === '/costs') {
          return handleCosts(xmRoot, req);
        }

        // GET /api/ws/:wsId/memory
        if (subPath === '/memory') {
          return handleMemoryList(xmRoot, url, req);
        }

        // GET /api/ws/:wsId/memory/:id
        const wsMemoryDetailMatch = subPath.match(/^\/memory\/([^/]+)$/);
        if (wsMemoryDetailMatch) {
          const id = decodeURIComponent(wsMemoryDetailMatch[1]);
          return handleMemoryDetail(xmRoot, id, req);
        }

        // GET /api/ws/:wsId/review/last
        if (subPath === '/review/last') {
          return handleReviewLast(xmRoot, req);
        }

        // GET /api/ws/:wsId/review/gate
        if (subPath === '/review/gate') {
          return handleReviewGate(xmRoot, req);
        }

        // GET /api/ws/:wsId/review/history/:file  (must come before /review/history)
        const wsReviewFileMatch = subPath.match(/^\/review\/history\/([^/]+)$/);
        if (wsReviewFileMatch) {
          const file = decodeURIComponent(wsReviewFileMatch[1]);
          return handleReviewHistoryFile(xmRoot, file, req);
        }

        // GET /api/ws/:wsId/review/history
        if (subPath === '/review/history') {
          return handleReviewHistory(xmRoot, req);
        }

        // GET /api/ws/:wsId/eval/:category/:file
        const wsEvalFileMatch = subPath.match(/^\/eval\/([^/]+)\/([^/]+)$/);
        if (wsEvalFileMatch) {
          const category = decodeURIComponent(wsEvalFileMatch[1]);
          const file = decodeURIComponent(wsEvalFileMatch[2]);
          return handleEvalFile(xmRoot, category, file, req);
        }

        // GET /api/ws/:wsId/eval
        if (subPath === '/eval') {
          return handleEvalList(xmRoot, req);
        }

        // GET /api/ws/:wsId/humble/:kind/:file
        const wsHumbleFileMatch = subPath.match(/^\/humble\/([^/]+)\/([^/]+)$/);
        if (wsHumbleFileMatch) {
          const kind = decodeURIComponent(wsHumbleFileMatch[1]);
          const file = decodeURIComponent(wsHumbleFileMatch[2]);
          return handleHumbleFile(xmRoot, kind, file, req);
        }

        // GET /api/ws/:wsId/humble
        if (subPath === '/humble') {
          return handleHumbleList(xmRoot, req);
        }

        // GET /api/ws/:wsId/session-state
        if (subPath === '/session-state') {
          return handleSessionState(xmRoot, req);
        }

        // GET /api/ws/:wsId/sync
        if (subPath === '/sync') {
          return handleSync(req);
        }

        // GET /api/ws/:wsId/handoffs
        if (subPath === '/handoffs') {
          return handleHandoffs(xmRoot, req);
        }

        // GET /api/ws/:wsId/prd
        if (subPath === '/prd') {
          return handlePrdList(xmRoot, req);
        }

        // GET /api/ws/:wsId/prd/:name
        const wsPrdDetailMatch = subPath.match(/^\/prd\/([^/]+)$/);
        if (wsPrdDetailMatch) {
          const name = decodeURIComponent(wsPrdDetailMatch[1]);
          return handlePrdDetail(xmRoot, name, req);
        }

        // GET /api/ws/:wsId/research
        if (subPath === '/research') {
          return handleResearchList(xmRoot, req);
        }

        // GET /api/ws/:wsId/research/:id
        const wsResearchDetailMatch = subPath.match(/^\/research\/([^/]+)$/);
        if (wsResearchDetailMatch) {
          const id = decodeURIComponent(wsResearchDetailMatch[1]);
          return handleResearchDetail(xmRoot, id, req);
        }

        // GET /api/ws/:wsId/recall
        if (subPath === '/recall') {
          return handleRecallList(xmRoot, req);
        }

        // GET /api/ws/:wsId/recall/:id
        const wsRecallDetailMatch = subPath.match(/^\/recall\/(.+)$/);
        if (wsRecallDetailMatch) {
          return handleRecallDetail(xmRoot, decodeURIComponent(wsRecallDetailMatch[1]), req);
        }

        // GET /api/ws/:wsId/panel/providers (before the :run match)
        if (subPath === '/panel/providers') {
          return handlePanelProviders(xmRoot, req);
        }
        // GET /api/ws/:wsId/panel/models — live per-vendor model catalog
        if (subPath === '/panel/models') {
          return handlePanelModels(req);
        }

        // GET /api/ws/:wsId/panel
        if (subPath === '/panel') {
          return handlePanelList(xmRoot, req);
        }

        // GET /api/ws/:wsId/panel/:run
        const wsPanelDetailMatch = subPath.match(/^\/panel\/(.+)$/);
        if (wsPanelDetailMatch) {
          return handlePanelDetail(xmRoot, decodeURIComponent(wsPanelDetailMatch[1]), req);
        }

        return jsonResponseWithETag({ error: 'not_found' }, req, 404);
      }

      // ── Legacy unscoped routes (backward compatible) ──────────

      // GET /api/config/model-routing
      if (path === '/api/config/model-routing') {
        return handleModelRouting(XM_ROOT, req);
      }

      // GET /api/config
      if (path === '/api/config') {
        return handleConfig(XM_ROOT, req);
      }

      // GET /api/projects
      if (path === '/api/projects') {
        return handleProjects(XM_ROOT, req);
      }

      // GET /api/later
      if (path === '/api/later') {
        return handleLaterAll(XM_ROOT, req);
      }

      // GET /api/projects/:slug/tasks
      const tasksMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
      if (tasksMatch) {
        const slug = decodeURIComponent(tasksMatch[1]);
        return handleProjectTasks(XM_ROOT, slug, req);
      }

      // GET /api/projects/:slug/later
      const laterMatch = path.match(/^\/api\/projects\/([^/]+)\/later$/);
      if (laterMatch) {
        const slug = decodeURIComponent(laterMatch[1]);
        return handleProjectLater(XM_ROOT, slug, req);
      }

      // GET /api/projects/:slug/gate
      const gateMatch = path.match(/^\/api\/projects\/([^/]+)\/gate$/);
      if (gateMatch) {
        const slug = decodeURIComponent(gateMatch[1]);
        return handleProjectGate(XM_ROOT, slug, req);
      }

      // GET /api/projects/:slug
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        const slug = decodeURIComponent(projectMatch[1]);
        return handleProjectDetail(XM_ROOT, slug, req);
      }

      // GET /api/probe/latest
      if (path === '/api/probe/latest') {
        return handleProbeLatest(XM_ROOT, req);
      }

      // GET /api/probe/diff?a=<file>&b=<file>
      if (path === '/api/probe/diff') {
        return handleProbeDiff(XM_ROOT, url, req);
      }

      // GET /api/probe/history/:file  (must come before /api/probe/history)
      const probeFileMatch = path.match(/^\/api\/probe\/history\/([^/]+)$/);
      if (probeFileMatch) {
        const file = decodeURIComponent(probeFileMatch[1]);
        return handleProbeHistoryFile(XM_ROOT, file, req);
      }

      // GET /api/probe/history
      if (path === '/api/probe/history') {
        return handleProbeHistory(XM_ROOT, req);
      }

      // GET /api/op
      if (path === '/api/op') {
        return handleOpList(XM_ROOT, req);
      }

      // GET /api/op/:file
      const opMatch = path.match(/^\/api\/op\/([^/]+)$/);
      if (opMatch) {
        const file = decodeURIComponent(opMatch[1]);
        return handleOpDetail(XM_ROOT, file, req);
      }

      // GET /api/solver
      if (path === '/api/solver') {
        return handleSolverList(XM_ROOT, req);
      }

      // GET /api/solver/:slug
      const solverMatch = path.match(/^\/api\/solver\/([^/]+)$/);
      if (solverMatch) {
        const slug = decodeURIComponent(solverMatch[1]);
        return handleSolverDetail(XM_ROOT, slug, req);
      }

      // GET /api/session-state
      if (path === '/api/session-state') {
        return handleSessionState(XM_ROOT, req);
      }

      // GET /api/search?q=keyword
      if (path === '/api/search') {
        return handleSearch(XM_ROOT, url, req);
      }

      // GET /api/metrics/sessions
      if (path === '/api/metrics/sessions') {
        return handleMetricsSessions(XM_ROOT, url, req);
      }

      // GET /api/traces
      if (path === '/api/traces') {
        return handleTraces(XM_ROOT, req);
      }

      // GET /api/traces/:file
      const tracesFileMatch = path.match(/^\/api\/traces\/([^/]+)$/);
      if (tracesFileMatch) {
        const file = decodeURIComponent(tracesFileMatch[1]);
        return handleTraceDetail(XM_ROOT, file, req, url);
      }

      // GET /api/costs
      if (path === '/api/costs') {
        return handleCosts(XM_ROOT, req);
      }

      // GET /api/memory
      if (path === '/api/memory') {
        return handleMemoryList(XM_ROOT, url, req);
      }

      // GET /api/memory/:id
      const memoryDetailMatch = path.match(/^\/api\/memory\/([^/]+)$/);
      if (memoryDetailMatch) {
        const id = decodeURIComponent(memoryDetailMatch[1]);
        return handleMemoryDetail(XM_ROOT, id, req);
      }

      // GET /api/review/last
      if (path === '/api/review/last') {
        return handleReviewLast(XM_ROOT, req);
      }

      // GET /api/review/gate
      if (path === '/api/review/gate') {
        return handleReviewGate(XM_ROOT, req);
      }

      // GET /api/review/history/:file  (must come before /api/review/history)
      const reviewFileMatch = path.match(/^\/api\/review\/history\/([^/]+)$/);
      if (reviewFileMatch) {
        const file = decodeURIComponent(reviewFileMatch[1]);
        return handleReviewHistoryFile(XM_ROOT, file, req);
      }

      // GET /api/review/history
      if (path === '/api/review/history') {
        return handleReviewHistory(XM_ROOT, req);
      }

      // GET /api/eval/:category/:file
      const evalFileMatch = path.match(/^\/api\/eval\/([^/]+)\/([^/]+)$/);
      if (evalFileMatch) {
        const category = decodeURIComponent(evalFileMatch[1]);
        const file = decodeURIComponent(evalFileMatch[2]);
        return handleEvalFile(XM_ROOT, category, file, req);
      }

      // GET /api/eval
      if (path === '/api/eval') {
        return handleEvalList(XM_ROOT, req);
      }

      // GET /api/humble/:kind/:file
      const humbleFileMatch = path.match(/^\/api\/humble\/([^/]+)\/([^/]+)$/);
      if (humbleFileMatch) {
        const kind = decodeURIComponent(humbleFileMatch[1]);
        const file = decodeURIComponent(humbleFileMatch[2]);
        return handleHumbleFile(XM_ROOT, kind, file, req);
      }

      // GET /api/humble
      if (path === '/api/humble') {
        return handleHumbleList(XM_ROOT, req);
      }

      // GET /api/sync
      if (path === '/api/sync') {
        return handleSync(req);
      }

      // GET /api/handoffs
      if (path === '/api/handoffs') {
        return handleHandoffs(XM_ROOT, req);
      }

      // GET /api/prd
      if (path === '/api/prd') {
        return handlePrdList(XM_ROOT, req);
      }

      // GET /api/prd/:name
      const prdDetailMatch = path.match(/^\/api\/prd\/([^/]+)$/);
      if (prdDetailMatch) {
        const name = decodeURIComponent(prdDetailMatch[1]);
        return handlePrdDetail(XM_ROOT, name, req);
      }

      // GET /api/research
      if (path === '/api/research') {
        return handleResearchList(XM_ROOT, req);
      }

      // GET /api/research/:id
      const researchDetailMatch = path.match(/^\/api\/research\/([^/]+)$/);
      if (researchDetailMatch) {
        const id = decodeURIComponent(researchDetailMatch[1]);
        return handleResearchDetail(XM_ROOT, id, req);
      }

      // GET /api/recall
      if (path === '/api/recall') {
        return handleRecallList(XM_ROOT, req);
      }

      // GET /api/recall/:id
      const recallDetailMatch = path.match(/^\/api\/recall\/(.+)$/);
      if (recallDetailMatch) {
        return handleRecallDetail(XM_ROOT, decodeURIComponent(recallDetailMatch[1]), req);
      }

      // GET /api/panel
      // GET /api/panel/providers (before the :run match)
      if (path === '/api/panel/providers') {
        return handlePanelProviders(XM_ROOT, req);
      }
      // GET /api/panel/models — live per-vendor model catalog (cursor kimi/glm, kiro glm…)
      if (path === '/api/panel/models') {
        return handlePanelModels(req);
      }

      // GET /api/panels/all — cross-workspace aggregate of running + recent panels
      if (path === '/api/panels/all') {
        return handlePanelsAll(req);
      }

      if (path === '/api/panel') {
        return handlePanelList(XM_ROOT, req);
      }

      // GET /api/panel/:run
      const panelDetailMatch = path.match(/^\/api\/panel\/(.+)$/);
      if (panelDetailMatch) {
        return handlePanelDetail(XM_ROOT, decodeURIComponent(panelDetailMatch[1]), req);
      }
    }

    // ── Static files ─────────────────────────────────────────────
    if (req.method === 'GET') {
      return serveStatic(path);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
});

// ── Handoffs Handler ───────────────────────────────────────────────

function handleHandoffs(xmRoot, req) {
  const items = [];

  // Scan .xm/handoff/ directory
  const handoffDir = join(xmRoot, 'handoff');
  if (existsSync(handoffDir)) {
    try {
      const files = readdirSync(handoffDir).filter(f => f.endsWith('.json') || f.endsWith('.md'));
      for (const file of files) {
        const filePath = safeJoin(handoffDir, file);
        if (!filePath) continue;
        try {
          let entry = { file, source: 'handoff' };
          if (file.endsWith('.json')) {
            const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
            Object.assign(entry, parsed);
          } else {
            const content = readFileSync(filePath, 'utf8');
            const titleMatch = content.match(/^#\s+(.+)/m);
            entry.title = titleMatch ? titleMatch[1].trim() : file;
            entry.content = content.slice(0, 200);
          }
          entry.file = file;
          items.push(entry);
        } catch {}
      }
    } catch {}
  }

  // Scan .xm/build/projects/*/handoff.json
  const projectsDir = join(xmRoot, 'build', 'projects');
  if (existsSync(projectsDir)) {
    try {
      const projects = readdirSync(projectsDir);
      for (const proj of projects) {
        const hPath = safeJoin(projectsDir, proj, 'HANDOFF.json');
        if (!hPath || !existsSync(hPath)) continue;
        try {
          const parsed = JSON.parse(readFileSync(hPath, 'utf8'));
          items.push({ ...parsed, project: proj, file: `${proj}/HANDOFF.json`, source: 'build' });
        } catch {}
      }
    } catch {}
  }

  // Sort by created_at desc
  items.sort((a, b) => {
    const ta = a.created_at ?? a.timestamp ?? '';
    const tb = b.created_at ?? b.timestamp ?? '';
    return tb.localeCompare(ta);
  });

  return jsonResponseWithETag({ data: items, total: items.length }, req);
}

// ── PRD handlers ───────────────────────────────────────────────────

function handlePrdList(xmRoot, req) {
  const items = [];
  // Standalone PRDs: .xm/prd/*.md (from `xm build plan` run without a project)
  const prdDir = safeJoin(xmRoot, 'prd');
  if (prdDir && existsSync(prdDir)) {
    try {
      for (const entry of readdirSync(prdDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const filePath = safeJoin(prdDir, entry.name);
        if (!filePath) continue;
        try {
          const st = statSync(filePath);
          items.push({ id: 's:' + entry.name, name: entry.name, source: 'standalone', mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    } catch {}
  }
  // Project PRDs: .xm/build/projects/<proj>/phases/02-plan/PRD.md (build flow)
  const projBase = safeJoin(xmRoot, 'build', 'projects');
  if (projBase && existsSync(projBase)) {
    try {
      for (const entry of readdirSync(projBase, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const prdPath = safeJoin(projBase, entry.name, 'phases', '02-plan', 'PRD.md');
        if (!prdPath || !existsSync(prdPath)) continue;
        try {
          const st = statSync(prdPath);
          items.push({ id: 'p:' + entry.name, name: entry.name, source: 'project', project: entry.name, mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    } catch {}
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return jsonResponseWithETag(items, req);
}

function handlePrdDetail(xmRoot, id, req) {
  // id prefix: 'p:<project>' → build-project PRD, 's:<file>' (or bare) → standalone
  let filePath;
  if (id.startsWith('p:')) {
    filePath = safeJoin(xmRoot, 'build', 'projects', id.slice(2), 'phases', '02-plan', 'PRD.md');
  } else {
    filePath = safeJoin(xmRoot, 'prd', id.startsWith('s:') ? id.slice(2) : id);
  }
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  try {
    return jsonResponseWithETag({ id, content: readFileSync(filePath, 'utf8') }, req);
  } catch {
    return jsonResponseWithETag({ error: 'read_error' }, req, 500);
  }
}

// ── Research handlers ──────────────────────────────────────────────

function handleResearchList(xmRoot, req) {
  const researchBase = safeJoin(xmRoot, 'research');
  if (!researchBase || !existsSync(researchBase)) return jsonResponseWithETag([], req);
  const items = [];
  try {
    for (const entry of readdirSync(researchBase, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('research-')) continue;
      const dirPath = safeJoin(researchBase, entry.name);
      if (!dirPath) continue;
      const boardPath = safeJoin(dirPath, 'board.jsonl');
      if (!boardPath) continue;
      let mtime = null;
      try { mtime = statSync(dirPath).mtimeMs; } catch {}
      if (!existsSync(boardPath)) {
        items.push({ id: entry.name, mtime, agents: 0, rounds: 0, findings: 0 });
        continue;
      }
      const entries = parseJsonlFile(boardPath);
      const agentSet = new Set();
      let maxRound = 0;
      for (const e of entries) {
        if (e && e.agent) agentSet.add(e.agent);
        if (e && typeof e.round === 'number' && e.round > maxRound) maxRound = e.round;
      }
      items.push({ id: entry.name, mtime, agents: agentSet.size, rounds: maxRound, findings: entries.length });
    }
  } catch {}
  items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return jsonResponseWithETag(items, req);
}

function handleResearchDetail(xmRoot, id, req) {
  const boardPath = safeJoin(xmRoot, 'research', id, 'board.jsonl');
  if (!boardPath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(boardPath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  const rawEntries = parseJsonlFile(boardPath);
  const entries = rawEntries.map(e => ({
    agent: e?.agent ?? null,
    round: e?.round ?? null,
    finding: e?.finding ?? null,
    source: e?.source ?? null,
    implication: e?.implication ?? null,
  }));
  return jsonResponseWithETag({ id, entries }, req);
}

// ── Sync Handler ───────────────────────────────────────────────────

async function handleSync(req) {
  const syncConfigPath = join(homedir(), '.xm', 'sync.json');
  const syncStatePath = join(XM_ROOT, '.sync-state.json');

  // Read local config
  let config = { machine_id: null, server_url: null, api_key: null };
  try { config = JSON.parse(readFileSync(syncConfigPath, 'utf8')); } catch {}
  // Env overrides (same as sync-config.mjs)
  if (process.env.XM_SYNC_SERVER_URL) config.server_url = process.env.XM_SYNC_SERVER_URL;
  if (process.env.XM_SYNC_API_KEY) config.api_key = process.env.XM_SYNC_API_KEY;
  // Auto-detect co-located x-sync server (same container)
  if (!config.server_url && process.env.XM_SYNC_DATA_DIR) {
    config.server_url = 'http://localhost:19842';
    config.api_key = config.api_key || '';
  }

  // Read sync state
  let syncState = { last_pull: 0 };
  try { syncState = JSON.parse(readFileSync(syncStatePath, 'utf8')); } catch {}

  const configured = !!(config.server_url);
  const result = {
    configured,
    machine_id: config.machine_id || 'server',
    server_url: config.server_url ? config.server_url.replace(/\/+$/, '') : null,
    last_pull: syncState.last_pull || 0,
    server: null,
  };

  // Probe sync server
  if (configured) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${result.server_url}/dashboard/health`, {
        headers: config.api_key ? { 'X-Api-Key': config.api_key } : {},
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const health = await res.json();
        // Also fetch projects
        const projRes = await fetch(`${result.server_url}/dashboard/projects`, {
          headers: config.api_key ? { 'X-Api-Key': config.api_key } : {},
        });
        const projects = projRes.ok ? await projRes.json() : [];
        result.server = { ...health, projects };
      }
    } catch {}
  }

  return jsonResponseWithETag(result, req);
}

// ── Process Management ──────────────────────────────────────────────

/**
 * Check for an existing dashboard instance.
 *
 * Two paths:
 *   1) PID file exists → check whether the recorded PID is still alive.
 *      Alive: exit with clear guidance. Dead: remove stale file and proceed.
 *   2) PID file missing → probe the listening port. If another process
 *      holds PORT, resolve its PID via lsof and exit with guidance.
 *      This recovers from cases where the PID file was deleted but the
 *      server is still running (e.g. ~/.xm/run/ wiped while server alive).
 */
function checkDuplicateInstance() {
  // Path 1: PID file exists
  if (existsSync(PID_FILE)) {
    let existing;
    try {
      existing = JSON.parse(readFileSync(PID_FILE, 'utf8'));
    } catch {
      removePIDFile();  // Corrupt PID file — clear and proceed to port check
      existing = null;
    }

    if (existing?.pid) {
      try {
        process.kill(existing.pid, 0);
        console.error(`[x-dashboard-server] Already running (pid: ${existing.pid}, port: ${existing.port})`);
        console.error(`[x-dashboard-server] Stop it first: kill ${existing.pid}`);
        console.error(`[x-dashboard-server]   or: xm dashboard stop`);
        process.exit(1);
      } catch {
        console.log(`[x-dashboard-server] Removing stale PID file (pid: ${existing.pid} not found)`);
        removePIDFile();
      }
    }
  }

  // Path 2: port probe — PID file absent but port may be held by an orphan
  const holder = findPortHolder(PORT);
  if (holder) {
    console.error(`[x-dashboard-server] Port ${PORT} already in use (pid: ${holder.pid}, cmd: ${holder.cmd})`);
    console.error(`[x-dashboard-server] This may be an orphaned dashboard with a deleted PID file.`);
    console.error(`[x-dashboard-server] Stop it: kill ${holder.pid}`);
    console.error(`[x-dashboard-server]   then: xm dashboard start`);
    process.exit(1);
  }
}

/** Return { pid, cmd } of the process listening on `port`, or null. macOS/Linux only. */
function findPortHolder(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fpc 2>/dev/null`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (!out) return null;
    let pid = null;
    let cmd = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) pid = line.slice(1).trim();
      else if (line.startsWith('c')) cmd = line.slice(1).trim();
    }
    return pid ? { pid, cmd: cmd || 'unknown' } : null;
  } catch {
    return null;
  }
}

function writePIDFile() {
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify({
    pid: process.pid,
    port: PORT,
    startedAt: new Date().toISOString(),
    version: VERSION,
    mode: SESSION_MODE ? 'session' : 'standalone',
  }, null, 2) + '\n', { mode: 0o600 });
}

function removePIDFile() {
  try { unlinkSync(PID_FILE); } catch {}
}

function shutdown() {
  console.log('[x-dashboard-server] Shutting down...');
  removePIDFile();
  server.stop();
  process.exit(0);
}

// Signal handlers — ensure PID file is cleaned up on every exit path.
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);  // terminal closed / nohup parent exit
process.on('exit', () => {
  // Last-chance cleanup. `exit` is synchronous; only unlink the PID file,
  // skip server.stop() (not safe async here).
  try { unlinkSync(PID_FILE); } catch {}
});
process.on('uncaughtException', (err) => {
  console.error('[x-dashboard-server] Uncaught exception:', err);
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(1);
});

// ── Browser Open ─────────────────────────────────────────────────────

function openBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      execSync(`open "${url}"`, { stdio: 'ignore' });
    } else if (platform === 'linux') {
      execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
    } else if (platform === 'win32') {
      execSync(`start "" "${url}"`, { stdio: 'ignore', shell: true });
    }
  } catch {
    // Non-fatal — browser open is best-effort
  }
}

// ── Startup ─────────────────────────────────────────────────────────

writePIDFile();
resetIdleTimer();

// ── M2: Workspace initialization ─────────────────────────────────────
// Priority: --scan flag > ~/.xm/projects.json registry > scan_roots > single cwd mode
function loadProjectRegistry() {
  const path = join(homedir(), '.xm', 'projects.json');
  if (!existsSync(path)) return [];
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8'));
    if (!obj || !Array.isArray(obj.projects)) return [];
    return obj.projects.filter((p) => !p.archived && existsSync(join(p.path, '.xm')));
  } catch {
    return [];
  }
}

/**
 * Rebuild `workspaces` from disk. Idempotent — can be called on startup
 * or when the registry changes (via /api/rescan or mtime watcher).
 * Returns { source: 'scan'|'registry'|'scan_roots'|'cwd', count, summary }.
 */
function rebuildWorkspaces({ silent = false } = {}) {
  const log = silent ? () => {} : (msg) => console.log(`[x-dashboard-server] ${msg}`);

  if (SCAN_DIR) {
    workspaces = scanWorkspaces(resolve(SCAN_DIR));
    log(`Multi-root: ${workspaces.length} workspaces from ${SCAN_DIR}`);
    return { source: 'scan', count: workspaces.length };
  }

  const registered = loadProjectRegistry();
  if (registered.length > 0) {
    workspaces = registered.map((p) => ({
      id: p.id,
      name: p.name || p.id,
      path: p.path,
      xmRoot: join(p.path, '.xm'),
    }));
    log(`Registry: ${workspaces.length} project(s) from ~/.xm/projects.json`);
    return { source: 'registry', count: workspaces.length };
  }

  // Legacy fallback: ~/.xm/config.json scan_roots
  const globalConfigPath = join(homedir(), '.xm', 'config.json');
  let scanRoots = null;
  try {
    const globalConfig = JSON.parse(readFileSync(globalConfigPath, 'utf8'));
    if (Array.isArray(globalConfig.scan_roots) && globalConfig.scan_roots.length > 0) {
      scanRoots = globalConfig.scan_roots;
    }
  } catch {}

  if (scanRoots) {
    workspaces = [];
    for (const root of scanRoots) {
      const resolved = resolve(root.replace(/^~/, homedir()));
      workspaces.push(...scanWorkspaces(resolved));
    }
    const seen = new Set();
    workspaces = workspaces.filter(w => {
      if (seen.has(w.xmRoot)) return false;
      seen.add(w.xmRoot);
      return true;
    });
    log(`Multi-root: ${workspaces.length} workspaces from scan_roots: ${scanRoots.join(', ')}`);
    return { source: 'scan_roots', count: workspaces.length };
  }

  workspaces = [{ id: basename(process.cwd()), name: basename(process.cwd()), path: process.cwd(), xmRoot: XM_ROOT }];
  log('Single-project mode. Tip: run `xm project import` to register projects globally.');
  return { source: 'cwd', count: 1 };
}

rebuildWorkspaces();

// Auto-rescan: watch ~/.xm/projects.json mtime so new `xm project add` entries
// appear without a server restart. Cheap (single fs.stat per tick, 30s interval).
const REGISTRY_PATH = join(homedir(), '.xm', 'projects.json');
let lastRegistryMtime = 0;
try { lastRegistryMtime = statSync(REGISTRY_PATH).mtimeMs; } catch {}
if (!SCAN_DIR) {
  setInterval(() => {
    let mtime = 0;
    try { mtime = statSync(REGISTRY_PATH).mtimeMs; } catch {}
    if (mtime !== lastRegistryMtime) {
      lastRegistryMtime = mtime;
      const before = workspaces.length;
      const result = rebuildWorkspaces({ silent: true });
      if (result.count !== before) {
        console.log(`[x-dashboard-server] Auto-rescan: ${before} → ${result.count} workspaces (${result.source})`);
      }
    }
  }, 30_000).unref?.();
}

const dashboardUrl = `http://127.0.0.1:${PORT}`;
console.log(`[x-dashboard-server] Started on ${dashboardUrl} (pid: ${process.pid})`);
console.log(`[x-dashboard-server] Serving static files from: ${PUBLIC_DIR}`);
console.log(`[x-dashboard-server] Mode: ${SESSION_MODE ? `session (idle timeout: ${SESSION_IDLE_TIMEOUT_MS / 60000}m)` : 'standalone'}`);
console.log(`[x-dashboard-server] PID file: ${PID_FILE}`);

// Skip browser open in test/CI environments or when NO_BROWSER is set
if (!process.env.NO_BROWSER && !process.env.CI && !process.env.BUN_TEST) {
  openBrowser(dashboardUrl);
}

// ── Helpers ─────────────────────────────────────────────────────────

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}
