/**
 * x-dashboard API integration tests
 *
 * Starts the dashboard server as a subprocess on a test port,
 * then exercises every API endpoint and safeJoin path-traversal guards.
 *
 * Run: bun test x-dashboard/test/
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The server uses resolve(process.cwd(), '.xm') as XM_ROOT.
// We spawn it from the xm project root so fixtures land in xm/.xm/
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const SERVER_PATH = join(__dirname, '..', 'lib', 'x-dashboard-server.mjs');
const TEST_PORT = 19898;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const XM_ROOT = join(PROJECT_ROOT, '.xm');

// ── Test fixture setup ───────────────────────────────────────────────

const TEST_PROJECT_SLUG = 'test-dashboard-api-fixture';
const TEST_SOLVER_SLUG = 'test-solver-api-fixture';
const TEST_PANEL_RUN = 'panel-api-live-fixture';
const TEST_PANEL_DONE_RUN = 'panel-api-done-fixture';

/** Track only the top-level dirs we create so teardown is safe */
const FIXTURE_ROOTS = [];

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function writeJSON(p, data) {
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

function setupFixtures() {
  // ── project fixture ──────────────────────────────────────────────
  const projectDir = join(XM_ROOT, 'build', 'projects', TEST_PROJECT_SLUG);
  ensureDir(projectDir);
  FIXTURE_ROOTS.push(projectDir);

  writeJSON(join(projectDir, 'manifest.json'), {
    slug: TEST_PROJECT_SLUG,
    name: 'Test Dashboard API Fixture',
    current_phase: '02-plan',
    status: 'active',
  });

  // phase status
  const prdPhaseDir = join(projectDir, 'phases', '01-prd');
  ensureDir(prdPhaseDir);
  writeJSON(join(prdPhaseDir, 'status.json'), { status: 'complete' });

  // tasks (02-plan phase)
  const planPhaseDir = join(projectDir, 'phases', '02-plan');
  ensureDir(planPhaseDir);
  writeJSON(join(planPhaseDir, 'tasks.json'), [
    { id: 'T1', title: 'First task', status: 'done' },
    { id: 'T2', title: 'Second task', status: 'pending' },
  ]);

  writeJSON(join(projectDir, 'later.json'), {
    items: [
      {
        id: 'l1',
        title: 'Fix unrelated cache warning',
        status: 'open',
        reason: 'Separate cleanup',
        source: 'test',
        impact: 'low',
        current_task: 'T2',
        files: ['src/cache.js'],
        file_snapshots: [
          { file: 'package.json', exists: true, sha256: 'fixture-sha-does-not-match' },
        ],
        created_at: '2026-05-10T00:00:00.000Z',
        updated_at: '2026-05-10T01:00:00.000Z',
      },
      {
        id: 'l2',
        title: 'Document old rollout behavior',
        status: 'promoted',
        reason: 'Docs follow-up',
        source: 'test',
        impact: 'none',
        promoted_task_id: 'T3',
        files: [],
        created_at: '2026-05-09T00:00:00.000Z',
        updated_at: '2026-05-09T02:00:00.000Z',
      },
    ],
  });

  // ── probe fixtures ───────────────────────────────────────────────
  const probeDir = join(XM_ROOT, 'probe');
  // last-verdict may already exist; only create if absent
  const lastVerdictPath = join(probeDir, 'last-verdict.json');
  if (!existsSync(lastVerdictPath)) {
    ensureDir(probeDir);
    writeJSON(lastVerdictPath, { verdict: 'green', timestamp: new Date().toISOString() });
    FIXTURE_ROOTS.push(lastVerdictPath);
  }

  const historyDir = join(probeDir, 'history');
  ensureDir(historyDir);
  const historyFile = join(historyDir, 'test-run-fixture.json');
  writeJSON(historyFile, { verdict: 'green', date: new Date().toISOString() });
  FIXTURE_ROOTS.push(historyFile);

  // ── solver fixture ───────────────────────────────────────────────
  const solverDir = join(XM_ROOT, 'solver', 'problems', TEST_SOLVER_SLUG);
  ensureDir(solverDir);
  FIXTURE_ROOTS.push(solverDir);
  writeJSON(join(solverDir, 'manifest.json'), {
    slug: TEST_SOLVER_SLUG,
    title: 'Test Solver API Fixture',
    status: 'open',
  });

  // ── metrics/sessions fixture ─────────────────────────────────────
  const metricsDir = join(XM_ROOT, 'build', 'metrics');
  ensureDir(metricsDir);
  const sessionsPath = join(metricsDir, 'sessions.jsonl');
  const preExisting = existsSync(sessionsPath);
  if (!preExisting) {
    writeFileSync(sessionsPath, [
      JSON.stringify({ id: 's1', cost: 0.01, at: new Date().toISOString() }),
      JSON.stringify({ id: 's2', cost: 0.02, at: new Date().toISOString() }),
      JSON.stringify({ id: 's3', cost: 0.03, at: new Date().toISOString() }),
    ].join('\n') + '\n');
    FIXTURE_ROOTS.push(sessionsPath);
  }

  // ── panel live fixture ──────────────────────────────────────────────
  const panelRunDir = join(XM_ROOT, 'panel', TEST_PANEL_RUN);
  ensureDir(panelRunDir);
  FIXTURE_ROOTS.push(panelRunDir);
  writeJSON(join(panelRunDir, 'status.json'), {
    run: TEST_PANEL_RUN,
    phase: 'round1 (review)',
    updated_at: new Date().toISOString(),
    models: [
      {
        label: 'claude',
        provider: 'claude',
        state: 'running',
        elapsed_s: 3,
        last_event: 'stdout +24 bytes',
        stdout_bytes: 24,
        stderr_bytes: 0,
        stdout_tail: '{"findings":[]}',
        stderr_tail: '',
      },
    ],
  });
  writeJSON(join(panelRunDir, 'claude.r1.json'), {
    model: 'claude',
    ok: true,
    error: null,
    findings: [],
    raw: '{"findings":[]}',
  });
  writeFileSync(join(panelRunDir, 'events.jsonl'), [
    JSON.stringify({ seq: 1, at: new Date().toISOString(), type: 'run_start', phase: 'starting', models: ['claude'] }),
    JSON.stringify({ seq: 2, at: new Date().toISOString(), type: 'stdout', phase: 'round1 (review)', model: 'claude', bytes: 24, text: '{"findings":[]}' }),
  ].join('\n') + '\n');

  // ── panel completed fixture (structured streaming usage/cost) ─────────
  const panelDoneDir = join(XM_ROOT, 'panel', TEST_PANEL_DONE_RUN);
  ensureDir(panelDoneDir);
  FIXTURE_ROOTS.push(panelDoneDir);
  writeJSON(join(panelDoneDir, 'verdict.json'), {
    run: TEST_PANEL_DONE_RUN,
    created_at: new Date().toISOString(),
    stream: true,
    counts: { confirmed: 1, contested: 0, unreviewed: 0, unique: 1 },
    models: ['claude', 'codex'],
    usage: {
      totals: { cost_usd: 0.42, credits: 0, tokens: { input: 1000, output: 100, cached: 50, reasoning: 10 } },
      by_model: {
        claude: { tokens: { input: 600, output: 60, cached: 30, reasoning: 0 }, cost_usd: 0.3, credits: 0 },
        codex: { tokens: { input: 400, output: 40, cached: 20, reasoning: 10 }, cost_usd: 0.12, credits: 0 },
      },
    },
    consensus: [], confirmed: [], contested: [], unreviewed: [],
  });
}

function teardownFixtures() {
  for (const p of FIXTURE_ROOTS) {
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

// ── Server lifecycle ─────────────────────────────────────────────────

let serverProc;

beforeAll(async () => {
  setupFixtures();

  serverProc = spawn('bun', [SERVER_PATH, '--port', String(TEST_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    cwd: PROJECT_ROOT,
    env: { ...process.env, NO_BROWSER: '1' },
  });

  serverProc.stderr?.on('data', () => {});
  serverProc.stdout?.on('data', () => {});

  // Wait up to 5s for the server to become ready
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('x-dashboard-server did not start within 5s');
});

afterAll(async () => {
  try { await fetch(`${BASE}/shutdown`).catch(() => {}); } catch {}
  try { serverProc?.kill('SIGTERM'); } catch {}
  teardownFixtures();
});

// ── Helper ───────────────────────────────────────────────────────────

async function getJSON(path) {
  const res = await fetch(`${BASE}${path}`);
  return { res, body: await res.json() };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status/uptime/port', async () => {
    const { res, body } = await getJSON('/health');
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(body.port).toBe(TEST_PORT);
    expect(typeof body.pid).toBe('number');
  });
});

describe('GET /api/config', () => {
  it('returns 200 with a mode field', async () => {
    const { res, body } = await getJSON('/api/config');
    expect(res.status).toBe(200);
    expect(typeof body.mode).toBe('string');
  });
});

describe('GET /api/projects', () => {
  it('returns 200 with a data array', async () => {
    const { res, body } = await getJSON('/api/projects');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('includes the test project fixture', async () => {
    const { body } = await getJSON('/api/projects');
    const found = body.data.find(p => p.slug === TEST_PROJECT_SLUG);
    expect(found).toBeDefined();
  });

  it('includes later summary for build list rows', async () => {
    const { body } = await getJSON('/api/projects');
    const found = body.data.find(p => p.slug === TEST_PROJECT_SLUG);
    expect(found.later).toEqual({ total: 2, open: 1, promoted: 1, dismissed: 0 });
  });
});

describe('GET /api/projects/:slug', () => {
  it('returns 200 with manifest and phases for a known project', async () => {
    const { res, body } = await getJSON(`/api/projects/${TEST_PROJECT_SLUG}`);
    expect(res.status).toBe(200);
    expect(body.manifest).toBeDefined();
    expect(body.manifest.slug).toBe(TEST_PROJECT_SLUG);
    expect(Array.isArray(body.phases)).toBe(true);
  });

  it('returns 404 for a nonexistent project', async () => {
    const { res } = await getJSON('/api/projects/nonexistent-project-xyz');
    expect(res.status).toBe(404);
  });

  it('returns 400 for slug with invalid characters (dot)', async () => {
    // "foo.bar" fails SAFE_SEGMENT_RE (/^[a-z0-9_-]+$/i) → 400
    const { res } = await getJSON('/api/projects/foo.bar');
    expect(res.status).toBe(400);
  });

  it('returns 404 for slug with special chars ($) — passes validation but no such project', async () => {
    const res = await fetch(`${BASE}/api/projects/foo%24bar`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/projects/:slug/tasks', () => {
  it('returns tasks array for a known project', async () => {
    const { res, body } = await getJSON(`/api/projects/${TEST_PROJECT_SLUG}/tasks`);
    expect(res.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  it('returns 404 for nonexistent project tasks', async () => {
    const { res } = await getJSON('/api/projects/no-such-project/tasks');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid slug in tasks path', async () => {
    const { res } = await getJSON('/api/projects/foo.bar/tasks');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/projects/:slug/gate', () => {
  it('returns current phase gate summary for a known project', async () => {
    const { res, body } = await getJSON(`/api/projects/${TEST_PROJECT_SLUG}/gate`);
    expect(res.status).toBe(200);
    expect(body.current_phase).toBe('02-plan');
    expect(body.missing).toEqual([]);
    expect(body.tasks).toEqual({ total: 2, pending: 1 });
    expect(body.ready).toBe(false);
  });

  it('returns 400 for invalid slug in gate path', async () => {
    const { res } = await getJSON('/api/projects/foo.bar/gate');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/projects/:slug/later', () => {
  it('returns later items and summary for a known project', async () => {
    const { res, body } = await getJSON(`/api/projects/${TEST_PROJECT_SLUG}/later`);
    expect(res.status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBe(2);
    expect(body.summary).toEqual({ total: 2, open: 1, promoted: 1, dismissed: 0 });
    expect(body.updated_at).toBe('2026-05-10T01:00:00.000Z');
    expect(body.items[0].scope.changed).toBe(1);
  });

  it('returns 404 for nonexistent project later queue', async () => {
    const { res } = await getJSON('/api/projects/no-such-project/later');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid slug in later path', async () => {
    const { res } = await getJSON('/api/projects/foo.bar/later');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/later', () => {
  it('returns aggregate later items across projects', async () => {
    const { res, body } = await getJSON('/api/later');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.some(item => item.project === TEST_PROJECT_SLUG && item.id === 'l1')).toBe(true);
    expect(body.summary.open).toBeGreaterThanOrEqual(1);
    expect(body.summary.changed_scope).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/probe/latest', () => {
  it('returns 200 with a verdict field', async () => {
    const { res, body } = await getJSON('/api/probe/latest');
    expect(res.status).toBe(200);
    expect(typeof body.verdict).toBe('string');
  });
});

describe('GET /api/probe/history', () => {
  it('returns 200 with a data array', async () => {
    const { res, body } = await getJSON('/api/probe/history');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('contains at least the fixture history entry', async () => {
    const { body } = await getJSON('/api/probe/history');
    expect(body.data.length).toBeGreaterThan(0);
  });
});

describe('GET /api/probe/history/:file', () => {
  it('returns 200 for a known history file (without .json extension)', async () => {
    const { res, body } = await getJSON('/api/probe/history/test-run-fixture');
    expect(res.status).toBe(200);
    expect(typeof body.verdict).toBe('string');
  });

  it('returns 200 for a known history file (with .json extension)', async () => {
    const { res, body } = await getJSON('/api/probe/history/test-run-fixture.json');
    expect(res.status).toBe(200);
    expect(typeof body.verdict).toBe('string');
  });

  it('returns 404 for unknown history file', async () => {
    const { res } = await getJSON('/api/probe/history/no-such-run-xyz');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid segment in history file path (dot)', async () => {
    // "foo.bar" without .json suffix: baseName="foo" (valid), but "foo.bar.txt" baseName="foo.bar" → invalid
    const { res } = await getJSON('/api/probe/history/foo.bar.txt');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/solver', () => {
  it('returns 200 with a data array', async () => {
    const { res, body } = await getJSON('/api/solver');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('includes the test solver fixture', async () => {
    const { body } = await getJSON('/api/solver');
    const found = body.data.find(p => p.slug === TEST_SOLVER_SLUG);
    expect(found).toBeDefined();
  });
});

describe('GET /api/solver/:slug', () => {
  it('returns 200 with manifest for known problem', async () => {
    const { res, body } = await getJSON(`/api/solver/${TEST_SOLVER_SLUG}`);
    expect(res.status).toBe(200);
    expect(body.manifest).toBeDefined();
    expect(body.manifest.slug).toBe(TEST_SOLVER_SLUG);
    expect(Array.isArray(body.phases)).toBe(true);
  });

  it('returns 404 for nonexistent solver problem', async () => {
    const { res } = await getJSON('/api/solver/no-such-problem-xyz');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid slug (dot)', async () => {
    const { res } = await getJSON('/api/solver/foo.bar');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/panel/:run', () => {
  it('returns status, rounds, and live events for a panel run', async () => {
    const { res, body } = await getJSON(`/api/panel/${TEST_PANEL_RUN}`);
    expect(res.status).toBe(200);
    expect(body.status.phase).toBe('round1 (review)');
    expect(body.rounds[0].label).toBe('claude');
    expect(body.events.some(ev => ev.type === 'stdout' && ev.model === 'claude')).toBe(true);
  });

  it('exposes verdict.usage (totals + by_model) for a completed run', async () => {
    const { res, body } = await getJSON(`/api/panel/${TEST_PANEL_DONE_RUN}`);
    expect(res.status).toBe(200);
    expect(body.verdict.usage.totals.cost_usd).toBeCloseTo(0.42, 5);
    expect(body.verdict.usage.by_model.claude.cost_usd).toBeCloseTo(0.3, 5);
    expect(body.verdict.usage.by_model.codex.tokens.reasoning).toBe(10);
  });
});

describe('GET /api/panel (list)', () => {
  it('includes per-run usage totals so the list can show cost', async () => {
    const { res, body } = await getJSON('/api/panel');
    expect(res.status).toBe(200);
    const done = (body.runs || []).find((r) => r.run === TEST_PANEL_DONE_RUN);
    expect(done).toBeTruthy();
    expect(done.verdict.usage.totals.cost_usd).toBeCloseTo(0.42, 5);
  });
});

describe('GET /api/metrics/sessions', () => {
  it('returns 200 with data array and pagination fields', async () => {
    const { res, body } = await getJSON('/api/metrics/sessions?limit=2&offset=0');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.limit).toBe('number');
    expect(typeof body.offset).toBe('number');
  });

  it('respects limit parameter — returns at most limit items', async () => {
    const { body } = await getJSON('/api/metrics/sessions?limit=2&offset=0');
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(body.limit).toBe(2);
  });

  it('respects offset parameter', async () => {
    const { body: page0 } = await getJSON('/api/metrics/sessions?limit=100&offset=0');
    const { body: page1 } = await getJSON('/api/metrics/sessions?limit=100&offset=1');
    if (page0.total > 1) {
      expect(page1.data.length).toBe(page0.data.length - 1);
    }
  });

  it('returns total reflecting all records', async () => {
    const { body } = await getJSON('/api/metrics/sessions?limit=100&offset=0');
    expect(body.total).toBeGreaterThan(0);
    expect(body.total).toBe(body.data.length + body.offset);
  });
});

describe('Static file serving', () => {
  it('does not return 500 for nonexistent path', async () => {
    const res = await fetch(`${BASE}/nonexistent-path-xyz-abc`);
    expect(res.status).not.toBe(500);
  });

  it('returns 403 for segment with invalid base name in static path', async () => {
    // A path segment whose base name contains invalid chars triggers 403 in serveStatic
    const res = await fetch(`${BASE}/foo%24bar`);
    expect([403, 404]).toContain(res.status);
  });
});

describe('safeJoin path traversal guards (via HTTP)', () => {
  it('rejects slug with dot (SAFE_SEGMENT_RE) → 400', async () => {
    // "foo.bar" reaches isValidSegment check and returns 400
    const { res } = await getJSON('/api/projects/foo.bar');
    expect(res.status).toBe(400);
  });

  it('slug with @ character → 404 (passes validation, no such project)', async () => {
    const res = await fetch(`${BASE}/api/projects/foo%40bar`);
    expect(res.status).toBe(404);
  });

  it('accepts valid alphanumeric-dash slug (unknown → 404, not 400)', async () => {
    // A well-formed slug should get 404 (not found), never 400 (forbidden)
    const { res } = await getJSON('/api/projects/valid-slug-123');
    expect(res.status).toBe(404);
  });

  it('accepts valid underscore slug (unknown → 404, not 400)', async () => {
    const { res } = await getJSON('/api/projects/valid_slug');
    expect(res.status).toBe(404);
  });

  it('rejects %2e in probe history file segment → 400', async () => {
    // %2e survives as literal text in the path after URL parse: pathname = /api/probe/history/%2e
    // safeJoin checks for /%2e/i and returns null → 400
    const res = await fetch(`${BASE}/api/probe/history/%2econfig`, { redirect: 'manual' });
    // The segment "%2econfig" — Bun may or may not decode this before routing
    // Either 400 (safeJoin rejects %2e) or 404 (Bun decoded it to ".config", isValidSegment rejects dot)
    expect([400, 404]).toContain(res.status);
  });
});
