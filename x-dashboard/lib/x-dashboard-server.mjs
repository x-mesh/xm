#!/usr/bin/env bun
/**
 * x-dashboard-server.mjs — Bun HTTP server for xm-dashboard
 *
 * Architecture: Bun HTTP server → serves static files from public/ + JSON API
 * Pattern: follows x-kit-server.mjs for PID file management and shutdown
 *
 * Usage: bun x-dashboard-server.mjs [--port N] [--session] [--scan <dir>]
 *
 * Mode A (default):  standalone, no idle timeout
 * Mode B (--session): 60 min idle timeout
 * Mode C (--scan <dir>): multi-root workspace mode
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

// ── Config ──────────────────────────────────────────────────────────

const DEFAULT_PORT = 19841;
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const VERSION = '0.1.0';

const args = process.argv.slice(2);
const STOP_MODE = args.includes('--stop');
const PORT = parseInt(getArg('--port') ?? String(DEFAULT_PORT), 10);
const SESSION_MODE = args.includes('--session');
const SCAN_DIR = getArg('--scan');
const RUN_DIR = join(homedir(), '.xm', 'run');
const PID_FILE = join(RUN_DIR, 'xdashboard-server.pid');
const SERVER_DIR = resolve(dirname(new URL(import.meta.url).pathname));
const PUBLIC_DIR = resolve(SERVER_DIR, '..', 'public');

const XM_ROOT = resolve(process.cwd(), '.xm');

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

  return new Response(file, {
    headers: { 'Content-Type': getMime(filePath) },
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
function scanWorkspaces(rootDir, maxDepth = 4) {
  const results = [];

  function scan(dir, depth) {
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
            const id = basename(fullPath);
            results.push({
              id,
              name: id,
              path: fullPath,
              xmRoot: xmPath,
            });
            // Don't recurse into a workspace — scan its siblings instead
            continue;
          }
        } catch {
          // stat failed, skip
        }
      }
      scan(fullPath, depth + 1);
    }
  }

  // Also check rootDir itself
  const rootXm = join(rootDir, '.xm');
  if (existsSync(rootXm)) {
    try {
      const stat = statSync(rootXm);
      if (stat.isDirectory()) {
        const id = basename(rootDir);
        results.push({ id, name: id, path: rootDir, xmRoot: rootXm });
      }
    } catch {}
  } else {
    scan(rootDir, 1);
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

// ── Route handler functions (accept xmRoot parameter) ────────────────

function handleConfig(xmRoot, req) {
  const filePath = safeJoin(xmRoot, 'config.json');
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  try {
    return jsonResponseWithETag(JSON.parse(readFileSync(filePath, 'utf8')), req);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file: 'config.json' }, req, 500);
  }
}

function handleProjects(xmRoot, req) {
  const projectsDir = safeJoin(xmRoot, 'build', 'projects');
  if (!projectsDir || !existsSync(projectsDir)) return jsonResponseWithETag({ data: [] }, req);
  const manifests = [];
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = safeJoin(projectsDir, entry.name, 'manifest.json');
    if (!manifestPath || !existsSync(manifestPath)) continue;
    try {
      manifests.push(JSON.parse(readFileSync(manifestPath, 'utf8')));
    } catch {
      // skip unparseable manifests
    }
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

  return jsonResponseWithETag({ manifest, circuitBreaker, handoff, phases, context }, req);
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

function handleProbeHistoryFile(xmRoot, file, req) {
  const baseName = file.endsWith('.json') ? file.slice(0, -5) : file;
  if (!isValidSegment(baseName)) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  const fileName = file.endsWith('.json') ? file : file + '.json';
  const filePath = safeJoin(xmRoot, 'probe', 'history', fileName);
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ error: 'not_found' }, req, 404);
  try {
    return jsonResponseWithETag(JSON.parse(readFileSync(filePath, 'utf8')), req);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file: fileName }, req, 500);
  }
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

function handleMetricsSessions(xmRoot, url, req) {
  const limit = Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));
  const filePath = safeJoin(xmRoot, 'build', 'metrics', 'sessions.jsonl');
  if (!filePath) return jsonResponseWithETag({ error: 'forbidden' }, req, 400);
  if (!existsSync(filePath)) return jsonResponseWithETag({ data: [], total: 0 }, req);
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
    const parsed = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line)); } catch {}
    }
    const total = parsed.length;
    return jsonResponseWithETag({ data: parsed.slice(offset, offset + limit), total, limit, offset }, req);
  } catch {
    return jsonResponseWithETag({ error: 'parse_error', file: 'sessions.jsonl' }, req, 500);
  }
}

// ── M4: WorkspaceAPI helpers ─────────────────────────────────────────

function countDirEntries(dirPath) {
  if (!dirPath || !existsSync(dirPath)) return 0;
  try {
    return readdirSync(dirPath).length;
  } catch {
    return 0;
  }
}

function getWorkspaceStats(ws) {
  const projectsDir = safeJoin(ws.xmRoot, 'build', 'projects');
  const probeHistoryDir = safeJoin(ws.xmRoot, 'probe', 'history');
  const solverDir = safeJoin(ws.xmRoot, 'solver', 'problems');
  return {
    projects: countDirEntries(projectsDir),
    probes: countDirEntries(probeHistoryDir),
    solvers: countDirEntries(solverDir),
  };
}

// ── Stop Mode (early exit — must run before server starts) ───────────

if (STOP_MODE) {
  if (!existsSync(PID_FILE)) {
    console.log('[x-dashboard-server] Not running (no PID file found)');
    process.exit(0);
  }

  let existing;
  try {
    existing = JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    console.error('[x-dashboard-server] Could not read PID file');
    process.exit(1);
  }

  const pid = existing?.pid;
  if (!pid) {
    console.error('[x-dashboard-server] PID file is malformed');
    process.exit(1);
  }

  // Check if alive
  try {
    process.kill(pid, 0);
  } catch {
    console.log(`[x-dashboard-server] Process ${pid} is not running (stale PID file)`);
    unlinkSync(PID_FILE);
    process.exit(0);
  }

  console.log(`[x-dashboard-server] Stopping pid ${pid} (port ${existing.port})...`);
  process.kill(pid, 'SIGTERM');

  // Wait up to 5s for the process to exit
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      console.log('[x-dashboard-server] Stopped.');
      process.exit(0);
    }
    const wait = Date.now() + 100;
    while (Date.now() < wait) {}
  }

  console.error(`[x-dashboard-server] Process ${pid} did not exit within 5s`);
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
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        port: PORT,
        pid: process.pid,
        mode: SESSION_MODE ? 'session' : 'standalone',
        cwd,
        project: projectName,
        xmRoot: XM_ROOT,
        workspaces: workspaces.length,
        multiRoot: workspaces.length > 1,
      });
    }

    // ── /shutdown ────────────────────────────────────────────────
    if (path === '/shutdown') {
      setTimeout(() => shutdown(), 100);
      return Response.json({ status: 'shutting_down' });
    }

    // ── JSON API ─────────────────────────────────────────────────
    if (req.method === 'GET' && path.startsWith('/api/')) {

      // ── M4: GET /api/workspaces ──────────────────────────────
      if (path === '/api/workspaces') {
        const data = workspaces.map(ws => ({
          id: ws.id,
          name: ws.name,
          path: ws.path,
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

        // GET /api/ws/:wsId/projects
        if (subPath === '/projects') {
          return handleProjects(xmRoot, req);
        }

        // GET /api/ws/:wsId/projects/:slug/tasks
        const wsTasksMatch = subPath.match(/^\/projects\/([^/]+)\/tasks$/);
        if (wsTasksMatch) {
          const slug = decodeURIComponent(wsTasksMatch[1]);
          return handleProjectTasks(xmRoot, slug, req);
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

        return jsonResponseWithETag({ error: 'not_found' }, req, 404);
      }

      // ── Legacy unscoped routes (backward compatible) ──────────

      // GET /api/config
      if (path === '/api/config') {
        return handleConfig(XM_ROOT, req);
      }

      // GET /api/projects
      if (path === '/api/projects') {
        return handleProjects(XM_ROOT, req);
      }

      // GET /api/projects/:slug/tasks
      const tasksMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
      if (tasksMatch) {
        const slug = decodeURIComponent(tasksMatch[1]);
        return handleProjectTasks(XM_ROOT, slug, req);
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

      // GET /api/search?q=keyword
      if (path === '/api/search') {
        return handleSearch(XM_ROOT, url, req);
      }

      // GET /api/metrics/sessions
      if (path === '/api/metrics/sessions') {
        return handleMetricsSessions(XM_ROOT, url, req);
      }
    }

    // ── Static files ─────────────────────────────────────────────
    if (req.method === 'GET') {
      return serveStatic(path);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  },
});

// ── Process Management ──────────────────────────────────────────────

function checkDuplicateInstance() {
  if (!existsSync(PID_FILE)) return;

  let existing;
  try {
    existing = JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch {
    return; // Corrupt PID file — proceed
  }

  const pid = existing?.pid;
  if (!pid) return;

  // Check if process is alive
  try {
    process.kill(pid, 0);
    // Process exists — warn and exit
    console.error(`[x-dashboard-server] Already running (pid: ${pid}, port: ${existing.port})`);
    console.error(`[x-dashboard-server] Stop it first: kill ${pid}`);
    process.exit(1);
  } catch {
    // Process not alive — stale PID file, remove and proceed
    console.log(`[x-dashboard-server] Removing stale PID file (pid: ${pid} not found)`);
    removePIDFile();
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

// Signal handlers
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

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
// Priority: --scan flag > ~/.xm/config.json scan_roots > single cwd mode
if (SCAN_DIR) {
  workspaces = scanWorkspaces(resolve(SCAN_DIR));
  console.log(`[x-dashboard-server] Multi-root: ${workspaces.length} workspaces from ${SCAN_DIR}`);
} else {
  // Try ~/.xm/config.json scan_roots
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
    // Deduplicate by xmRoot
    const seen = new Set();
    workspaces = workspaces.filter(w => {
      if (seen.has(w.xmRoot)) return false;
      seen.add(w.xmRoot);
      return true;
    });
    console.log(`[x-dashboard-server] Multi-root: ${workspaces.length} workspaces from scan_roots: ${scanRoots.join(', ')}`);
  } else {
    workspaces = [{ id: basename(process.cwd()), name: basename(process.cwd()), path: process.cwd(), xmRoot: XM_ROOT }];
  }
}

const dashboardUrl = `http://127.0.0.1:${PORT}`;
console.log(`[x-dashboard-server] Started on ${dashboardUrl} (pid: ${process.pid})`);
console.log(`[x-dashboard-server] Serving static files from: ${PUBLIC_DIR}`);
console.log(`[x-dashboard-server] Mode: ${SESSION_MODE ? `session (idle timeout: ${SESSION_IDLE_TIMEOUT_MS / 60000}m)` : 'standalone'}`);
console.log(`[x-dashboard-server] PID file: ${PID_FILE}`);

openBrowser(dashboardUrl);

// ── Helpers ─────────────────────────────────────────────────────────

function getArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}
