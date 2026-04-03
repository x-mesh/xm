#!/usr/bin/env bun
/**
 * x-dashboard-server.mjs — Bun HTTP server for xm-dashboard
 *
 * Architecture: Bun HTTP server → serves static files from public/ + JSON API
 * Pattern: follows x-kit-server.mjs for PID file management and shutdown
 *
 * Usage: bun x-dashboard-server.mjs [--port N] [--session]
 *
 * Mode A (default):  standalone, no idle timeout
 * Mode B (--session): 60 min idle timeout
 */

import { writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
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

const SAFE_SEGMENT_RE = /^[a-z0-9_-]+$/i;

function isValidSegment(segment) {
  return SAFE_SEGMENT_RE.test(segment);
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
      return Response.json({
        status: 'ok',
        version: VERSION,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        port: PORT,
        pid: process.pid,
        mode: SESSION_MODE ? 'session' : 'standalone',
      });
    }

    // ── /shutdown ────────────────────────────────────────────────
    if (path === '/shutdown') {
      setTimeout(() => shutdown(), 100);
      return Response.json({ status: 'shutting_down' });
    }

    // ── JSON API ─────────────────────────────────────────────────
    if (req.method === 'GET' && path.startsWith('/api/')) {

      // GET /api/config
      if (path === '/api/config') {
        const filePath = safeJoin(XM_ROOT, 'config.json');
        if (!filePath) return Response.json({ error: 'forbidden' }, { status: 400 });
        if (!existsSync(filePath)) return Response.json({ error: 'not_found' }, { status: 404 });
        try {
          return Response.json(JSON.parse(readFileSync(filePath, 'utf8')));
        } catch {
          return Response.json({ error: 'parse_error', file: 'config.json' }, { status: 500 });
        }
      }

      // GET /api/projects
      if (path === '/api/projects') {
        const projectsDir = safeJoin(XM_ROOT, 'build', 'projects');
        if (!projectsDir || !existsSync(projectsDir)) return Response.json({ data: [] });
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
        return Response.json({ data: manifests });
      }

      // GET /api/projects/:slug/tasks
      const tasksMatch = path.match(/^\/api\/projects\/([^/]+)\/tasks$/);
      if (tasksMatch) {
        const slug = tasksMatch[1];
        if (!isValidSegment(slug)) return Response.json({ error: 'forbidden' }, { status: 400 });
        const filePath = safeJoin(XM_ROOT, 'build', 'projects', slug, 'phases', '02-plan', 'tasks.json');
        if (!filePath) return Response.json({ error: 'forbidden' }, { status: 400 });
        if (!existsSync(filePath)) return Response.json({ error: 'not_found' }, { status: 404 });
        try {
          return Response.json(JSON.parse(readFileSync(filePath, 'utf8')));
        } catch {
          return Response.json({ error: 'parse_error', file: 'tasks.json' }, { status: 500 });
        }
      }

      // GET /api/projects/:slug
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch) {
        const slug = projectMatch[1];
        if (!isValidSegment(slug)) return Response.json({ error: 'forbidden' }, { status: 400 });
        const projectDir = safeJoin(XM_ROOT, 'build', 'projects', slug);
        if (!projectDir || !existsSync(projectDir)) return Response.json({ error: 'not_found' }, { status: 404 });

        const manifestPath = safeJoin(projectDir, 'manifest.json');
        if (!manifestPath || !existsSync(manifestPath)) return Response.json({ error: 'not_found' }, { status: 404 });
        let manifest;
        try {
          manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        } catch {
          return Response.json({ error: 'parse_error', file: 'manifest.json' }, { status: 500 });
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

        return Response.json({ manifest, circuitBreaker, handoff, phases, context });
      }

      // GET /api/probe/latest
      if (path === '/api/probe/latest') {
        const filePath = safeJoin(XM_ROOT, 'probe', 'last-verdict.json');
        if (!filePath) return Response.json({ error: 'forbidden' }, { status: 400 });
        if (!existsSync(filePath)) return Response.json({ error: 'not_found' }, { status: 404 });
        try {
          return Response.json(JSON.parse(readFileSync(filePath, 'utf8')));
        } catch {
          return Response.json({ error: 'parse_error', file: 'last-verdict.json' }, { status: 500 });
        }
      }

      // GET /api/probe/history/:file  (must come before /api/probe/history)
      const probeFileMatch = path.match(/^\/api\/probe\/history\/([^/]+)$/);
      if (probeFileMatch) {
        const file = probeFileMatch[1];
        const baseName = file.endsWith('.json') ? file.slice(0, -5) : file;
        if (!isValidSegment(baseName)) return Response.json({ error: 'forbidden' }, { status: 400 });
        const fileName = file.endsWith('.json') ? file : file + '.json';
        const filePath = safeJoin(XM_ROOT, 'probe', 'history', fileName);
        if (!filePath) return Response.json({ error: 'forbidden' }, { status: 400 });
        if (!existsSync(filePath)) return Response.json({ error: 'not_found' }, { status: 404 });
        try {
          return Response.json(JSON.parse(readFileSync(filePath, 'utf8')));
        } catch {
          return Response.json({ error: 'parse_error', file: fileName }, { status: 500 });
        }
      }

      // GET /api/probe/history
      if (path === '/api/probe/history') {
        const historyDir = safeJoin(XM_ROOT, 'probe', 'history');
        if (!historyDir || !existsSync(historyDir)) return Response.json({ data: [] });
        const results = [];
        for (const entry of readdirSync(historyDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          const filePath = safeJoin(historyDir, entry.name);
          if (!filePath) continue;
          try {
            results.push(JSON.parse(readFileSync(filePath, 'utf8')));
          } catch {}
        }
        results.sort((a, b) => {
          const da = a.date ?? a.timestamp ?? a.created_at ?? '';
          const db = b.date ?? b.timestamp ?? b.created_at ?? '';
          return db < da ? -1 : db > da ? 1 : 0;
        });
        return Response.json({ data: results });
      }

      // GET /api/solver
      if (path === '/api/solver') {
        const solverDir = safeJoin(XM_ROOT, 'solver', 'problems');
        if (!solverDir || !existsSync(solverDir)) return Response.json({ data: [] });
        const manifests = [];
        for (const entry of readdirSync(solverDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const manifestPath = safeJoin(solverDir, entry.name, 'manifest.json');
          if (!manifestPath || !existsSync(manifestPath)) continue;
          try {
            manifests.push(JSON.parse(readFileSync(manifestPath, 'utf8')));
          } catch {}
        }
        return Response.json({ data: manifests });
      }

      // GET /api/solver/:slug
      const solverMatch = path.match(/^\/api\/solver\/([^/]+)$/);
      if (solverMatch) {
        const slug = solverMatch[1];
        if (!isValidSegment(slug)) return Response.json({ error: 'forbidden' }, { status: 400 });
        const problemDir = safeJoin(XM_ROOT, 'solver', 'problems', slug);
        if (!problemDir || !existsSync(problemDir)) return Response.json({ error: 'not_found' }, { status: 404 });

        const manifestPath = safeJoin(problemDir, 'manifest.json');
        if (!manifestPath || !existsSync(manifestPath)) return Response.json({ error: 'not_found' }, { status: 404 });
        let manifest;
        try {
          manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        } catch {
          return Response.json({ error: 'parse_error', file: 'manifest.json' }, { status: 500 });
        }

        const phases = [];
        const phasesDir = safeJoin(problemDir, 'phases');
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

        return Response.json({ manifest, phases });
      }

      // GET /api/metrics/sessions
      if (path === '/api/metrics/sessions') {
        const limit = Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10));
        const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));
        const filePath = safeJoin(XM_ROOT, 'build', 'metrics', 'sessions.jsonl');
        if (!filePath) return Response.json({ error: 'forbidden' }, { status: 400 });
        if (!existsSync(filePath)) return Response.json({ data: [], total: 0 });
        try {
          const lines = readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim());
          const parsed = [];
          for (const line of lines) {
            try { parsed.push(JSON.parse(line)); } catch {}
          }
          const total = parsed.length;
          return Response.json({ data: parsed.slice(offset, offset + limit), total, limit, offset });
        } catch {
          return Response.json({ error: 'parse_error', file: 'sessions.jsonl' }, { status: 500 });
        }
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
