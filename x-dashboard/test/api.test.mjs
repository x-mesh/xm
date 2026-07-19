/**
 * x-dashboard API integration tests
 *
 * Starts the dashboard server as a subprocess on a test port,
 * then exercises every API endpoint and safeJoin path-traversal guards.
 *
 * Run: bun test x-dashboard/test/
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SCHEMA } from '../../x-build/lib/config-schema.mjs';

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
const TEST_CROSS_RUN = 'panel-api-cross-fixture';
const TEST_CROSS_LIVE_RUN = 'panel-api-cross-live-fixture';
const TEST_CROSS_STALE_RUN = 'panel-api-cross-stale-fixture';

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
    target_kind: 'literal',
    target_title: 'live review fixture',
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

  // ── cross-vendor fixture (.xm/cross/) — provenance-tagged sub-invocation ──
  const crossRunDir = join(XM_ROOT, 'cross', TEST_CROSS_RUN);
  ensureDir(crossRunDir);
  FIXTURE_ROOTS.push(crossRunDir);
  writeJSON(join(crossRunDir, 'result.json'), {
    run: TEST_CROSS_RUN,
    created_at: new Date().toISOString(),
    source: 'op:debate',
    title: 'cross-vendor moat',
    models: ['claude', 'codex'],
    prompt_chars: 1234,
    results: [
      { model: 'claude', provider: 'claude', ok: true, output: 'PRO argument body', error: null },
      { model: 'codex', provider: 'codex', ok: true, output: 'CON argument body', error: null },
    ],
  });

  // ── live cross run: heartbeat only (no result.json, no per-vendor files yet) ──
  // The status.json heartbeat is what makes a just-started cross run visible with
  // per-model live state instead of 404ing until the first vendor finishes.
  const crossLiveDir = join(XM_ROOT, 'cross', TEST_CROSS_LIVE_RUN);
  ensureDir(crossLiveDir);
  FIXTURE_ROOTS.push(crossLiveDir);
  writeJSON(join(crossLiveDir, 'status.json'), {
    kind: 'cross', run: TEST_CROSS_LIVE_RUN, source: 'op:brainstorm', title: 'live heartbeat fixture',
    prompt_chars: 987, started_at: new Date(Date.now() - 5000).toISOString(),
    updated_at: new Date().toISOString(),
    models: [
      { label: 'claude', provider: 'claude', state: 'running', elapsed_s: 5, stdout_bytes: 1200, last_event: 'stdout' },
      { label: 'codex', provider: 'codex', state: 'running', elapsed_s: 5, stdout_bytes: 0, last_event: 'spawn' },
    ],
  });

  // ── stalled cross run: heartbeat exists but is old — must NOT report running ──
  const crossStaleDir = join(XM_ROOT, 'cross', TEST_CROSS_STALE_RUN);
  ensureDir(crossStaleDir);
  FIXTURE_ROOTS.push(crossStaleDir);
  writeJSON(join(crossStaleDir, 'status.json'), {
    kind: 'cross', run: TEST_CROSS_STALE_RUN, source: 'op:debate', title: 'stalled heartbeat fixture',
    started_at: new Date(Date.now() - 600000).toISOString(),
    updated_at: new Date(Date.now() - 120000).toISOString(),
    models: [ { label: 'claude', provider: 'claude', state: 'running', elapsed_s: 90, stdout_bytes: 0 } ],
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

describe('GET /api/config/model-routing', () => {
  it('returns the resolved role→model matrix with phase groups', async () => {
    const { res, body } = await getJSON('/api/config/model-routing');
    expect(res.status).toBe(200);
    expect(['economy', 'default', 'max']).toContain(body.profile);
    expect(body.models).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(Object.keys(body.phase_groups).sort()).toEqual(['implement', 'plan', 'review']);
    // every phase-group role resolves with a valid model + source.
    // 'inherit' (session-model routing) is a valid role model but NOT a
    // billable tier, so it is absent from body.models by design.
    for (const roles of Object.values(body.phase_groups)) {
      for (const role of roles) {
        expect(body.roles[role]).toBeDefined();
        expect([...body.models, 'inherit']).toContain(body.roles[role].model);
        expect(['profile', 'override']).toContain(body.roles[role].source);
      }
    }
  });

  it('tier=global also resolves (structure only — content is user config)', async () => {
    const { res, body } = await getJSON('/api/config/model-routing?tier=global');
    expect(res.status).toBe(200);
    expect(body.roles).toBeDefined();
    expect(body.phase_groups).toBeDefined();
  });

  it('tier=build-local falls back to project resolution (no error, no special-case)', async () => {
    const { res, body } = await getJSON('/api/config/model-routing?tier=build-local');
    expect(res.status).toBe(200);
    expect(body.roles).toBeDefined();
    expect(body.phase_groups).toBeDefined();
  });
});

describe('GET /api/config/schema', () => {
  it('returns every registered key with its group, matching SCHEMA exactly', async () => {
    const { res, body } = await getJSON('/api/config/schema');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBe(SCHEMA.length);
    for (const entry of body.entries) {
      expect(typeof entry.key).toBe('string');
      expect(typeof entry.group).toBe('string');
    }
  });

  it('annotates worktree.* entries with runtime_default from WORKTREE_CONFIG_DEFAULTS', async () => {
    const { res, body } = await getJSON('/api/config/schema');
    expect(res.status).toBe(200);
    const worktreeEntries = body.entries.filter((e) => e.key.startsWith('worktree.'));
    expect(worktreeEntries.length).toBeGreaterThan(0);
    for (const entry of worktreeEntries) {
      expect(entry).toHaveProperty('runtime_default');
    }
  });
});

describe('GET/PATCH /api/config?tier=build-local (R2, config-gap-close, top-level merge only)', () => {
  // build-local resolves to .xm/build/config.json (the worktree 3-tier layer).
  // Guard it the same way the R2 skip block does: back up and restore around
  // every case so a real build-local config is never left mutated. These
  // cases only exercise plain top-level merge — the `_set` dotted-key deep
  // merge (R7) is a separate, still-unimplemented concern owned by t5.
  const BUILD_LOCAL_PATH = join(XM_ROOT, 'build', 'config.json');
  let hadFile, backup;

  beforeEach(() => {
    hadFile = existsSync(BUILD_LOCAL_PATH);
    backup = hadFile ? readFileSync(BUILD_LOCAL_PATH, 'utf8') : null;
  });

  afterEach(() => {
    if (hadFile) writeFileSync(BUILD_LOCAL_PATH, backup);
    else { try { rmSync(BUILD_LOCAL_PATH, { force: true }); } catch {} }
  });

  it('reports _empty:true and _tier:"build-local" when the file is absent', async () => {
    try { rmSync(BUILD_LOCAL_PATH, { force: true }); } catch {}
    const { res, body } = await getJSON('/api/config?tier=build-local');
    expect(res.status).toBe(200);
    expect(body._empty).toBe(true);
    expect(body._tier).toBe('build-local');
  });

  it('exposes the worktree sub-object when the file exists', async () => {
    mkdirSync(dirname(BUILD_LOCAL_PATH), { recursive: true });
    writeFileSync(BUILD_LOCAL_PATH, JSON.stringify({ worktree: { max_parallel: 7 } }));
    const { res, body } = await getJSON('/api/config?tier=build-local');
    expect(res.status).toBe(200);
    expect(body._tier).toBe('build-local');
    expect(body.worktree).toEqual({ max_parallel: 7 });
  });

  it('PATCH writes land in .xm/build/config.json, not the project tier file', async () => {
    try { rmSync(BUILD_LOCAL_PATH, { force: true }); } catch {}
    const patchRes = await fetch(`${BASE}/api/config?tier=build-local`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktree: { max_parallel: 9 } }),
    });
    expect(patchRes.status).toBe(200);
    expect(existsSync(BUILD_LOCAL_PATH)).toBe(true);
    const onDisk = JSON.parse(readFileSync(BUILD_LOCAL_PATH, 'utf8'));
    expect(onDisk.worktree?.max_parallel).toBe(9);
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

  it('tags review runs with kind + a review(<target_kind>) source', async () => {
    const { body } = await getJSON('/api/panel');
    const live = (body.runs || []).find((r) => r.run === TEST_PANEL_RUN);
    expect(live).toBeTruthy();
    expect(live.kind).toBe('review');
    expect(live.source).toBe('review(literal)'); // category visible without opening the run
  });

  it('surfaces cross-vendor runs with their provenance source + title', async () => {
    const { body } = await getJSON('/api/panel');
    const cross = (body.runs || []).find((r) => r.run === TEST_CROSS_RUN);
    expect(cross).toBeTruthy();          // .xm/cross/ runs now appear in the panel list
    expect(cross.kind).toBe('cross');
    expect(cross.source).toBe('op:debate');     // which workflow invoked it
    expect(cross.title).toBe('cross-vendor moat'); // human name, not a timestamp
    expect(cross.vendor_count).toBe(2);
    expect(cross.phase).toBe('done');
  });

  it('surfaces a live cross run from its status heartbeat with per-model state', async () => {
    const { body } = await getJSON('/api/panel');
    const live = (body.runs || []).find((r) => r.run === TEST_CROSS_LIVE_RUN);
    expect(live).toBeDefined();
    expect(live.phase).toBe('running');
    expect(live.status).toBeDefined();
    expect(live.status.models.length).toBe(2);
    expect(live.status.models[0].state).toBe('running');
    expect(live.models).toEqual(['claude', 'codex']);
  });

  it('marks a cross run with an old heartbeat as stalled, never running forever', async () => {
    const { body } = await getJSON('/api/panel');
    const stale = (body.runs || []).find((r) => r.run === TEST_CROSS_STALE_RUN);
    expect(stale).toBeDefined();
    expect(stale.phase).toBe('stalled');
  });
});

describe('GET /api/panel/:run (live cross heartbeat detail)', () => {
  it('serves a heartbeat-only cross run instead of 404 and includes live status', async () => {
    const { res, body } = await getJSON(`/api/panel/${TEST_CROSS_LIVE_RUN}`);
    expect(res.status).toBe(200);
    expect(body.kind).toBe('cross');
    expect(body.phase).toBe('running');
    expect(body.status.models.length).toBe(2);
    expect(Array.isArray(body.results)).toBe(true); // empty pre-vendor-files, present
  });
});

describe('GET /api/panels/all (cross-workspace aggregate)', () => {
  it('groups every project\'s panel + cross runs under its workspace', async () => {
    const { res, body } = await getJSON('/api/panels/all');
    expect(res.status).toBe(200);
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body.workspaces.length).toBeGreaterThanOrEqual(1); // single-project mode → one workspace
    const ws = body.workspaces[0];
    expect(ws.id).toBeTruthy();
    expect(Array.isArray(ws.runs)).toBe(true);
    // the cross fixture + review fixtures all live in this project → surfaced in the aggregate
    const allRuns = body.workspaces.flatMap((w) => w.runs);
    expect(allRuns.find((r) => r.run === TEST_CROSS_RUN)).toBeTruthy();
    expect(allRuns.find((r) => r.kind === 'cross' && r.source === 'op:debate')).toBeTruthy();
  });
});

describe('GET /api/panel/:run (cross detail)', () => {
  it('returns the per-vendor outputs for a cross run', async () => {
    const { res, body } = await getJSON(`/api/panel/${TEST_CROSS_RUN}`);
    expect(res.status).toBe(200);
    expect(body.kind).toBe('cross');
    expect(body.source).toBe('op:debate');
    expect(body.results).toHaveLength(2);
    expect(body.results[0].output).toBeTruthy(); // raw deliberation, readable in the detail view
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
      // page size is min(limit, remaining) — must hold whether total is under or over the limit
      expect(page1.data.length).toBe(Math.min(100, page0.total - 1));
    }
  });

  it('returns total reflecting all records', async () => {
    const { body } = await getJSON('/api/metrics/sessions?limit=100&offset=0');
    expect(body.total).toBeGreaterThan(0);
    expect(body.data.length).toBe(Math.min(body.limit, body.total - body.offset));
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

// ── config-schema cache-layout smoke (P3) ─────────────────────────────
//
// The main test server above always resolves config-schema.mjs / worktree-
// shared.mjs through the *source-tree* candidate (this repo has no flat
// x-dashboard/lib/config-schema.mjs), so it never exercises the *bundle*
// (flat) candidate that getConfigSchema()/getWorktreeShared() also support.
// Past regressions in this shape of dual-path loader shipped silently
// because tests only ever ran against the source-tree layout (P3). These
// cases simulate the real xm/lib bundle layout in a scratch dir — a copy of
// the server sitting flat next to config-schema.mjs, with worktree-shared.mjs
// one level down in x-build/ — to fail fast if the candidate paths drift.
describe('GET /api/config/schema — bundle-layout smoke (P3)', () => {
  const XM_LIB = join(PROJECT_ROOT, 'xm', 'lib');
  const SERVER_SRC = readFileSync(SERVER_PATH, 'utf8');
  const SCHEMA_SRC = readFileSync(join(XM_LIB, 'config-schema.mjs'), 'utf8');
  const WORKTREE_SRC = readFileSync(join(XM_LIB, 'x-build', 'worktree-shared.mjs'), 'utf8');

  async function bootSimulated(dir, port) {
    const proc = spawn('bun', [join(dir, 'server.mjs'), '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      cwd: dir,
      // Isolated RUN_DIR so this second instance's PID file never collides
      // with the real one the main test server (beforeAll, above) is using.
      env: { ...process.env, NO_BROWSER: '1', XM_DASHBOARD_RUN_DIR: join(dir, 'run') },
    });
    proc.stderr?.on('data', () => {});
    proc.stdout?.on('data', () => {});
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return proc;
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    try { proc.kill('SIGTERM'); } catch {}
    throw new Error(`simulated bundle-layout server did not start on port ${port}`);
  }

  it('resolves schema (200, full entry count) when config-schema.mjs + x-build/worktree-shared.mjs sit flat next to the server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xdb-bundle-smoke-'));
    let proc;
    const port = 19895;
    try {
      writeFileSync(join(dir, 'server.mjs'), SERVER_SRC);
      writeFileSync(join(dir, 'config-schema.mjs'), SCHEMA_SRC);
      mkdirSync(join(dir, 'x-build'), { recursive: true });
      writeFileSync(join(dir, 'x-build', 'worktree-shared.mjs'), WORKTREE_SRC);

      proc = await bootSimulated(dir, port);
      const res = await fetch(`http://127.0.0.1:${port}/api/config/schema`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.entries.length).toBe(SCHEMA.length);
    } finally {
      try { proc?.kill('SIGTERM'); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades to 503 when neither config-schema.mjs nor x-build/worktree-shared.mjs is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xdb-bundle-smoke-missing-'));
    let proc;
    const port = 19894;
    try {
      writeFileSync(join(dir, 'server.mjs'), SERVER_SRC);
      // Deliberately no config-schema.mjs, no x-build/worktree-shared.mjs.

      proc = await bootSimulated(dir, port);
      const res = await fetch(`http://127.0.0.1:${port}/api/config/schema`);
      expect(res.status).toBe(503);
    } finally {
      try { proc?.kill('SIGTERM'); } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── R14a/R14b: PATCH /api/config contract tests (config-gap-close) ───────────
//
// These pin the target contract from PRD phases/02-plan/PRD.md ("Critical API
// Contracts" + Day-0 Demo Script). Originally landed `.skip`'d as red-first
// tests (P8: PATCH had zero regression tests while the surface expands to 38
// keys x 3 tiers) before `_set` existed on the server. Activated by t5 once
// R7 (_set → setNestedKey), R8 (shadow warnings) and R9 (422 validation)
// landed in handleConfigPatch.
//
// Note: the `gates.research-exit` case below originally used the placeholder
// value 'off' (not in that key's registered enum). That predates R9's 422
// validation gate and would now correctly be rejected — the case is only
// about _set's dotted-key deep-merge preserving sibling keys, not about enum
// correctness, so the value was swapped for a schema-valid one ('quality').

describe('PATCH /api/config — _set dotted-key sibling preservation (R7, config-gap-close)', () => {
  // Tests write directly to the real project tier file (.xm/config.json)
  // because that's what tier=project (the default) resolves to. Back up and
  // restore around every case so a real project config is never left mutated.
  const CONFIG_PATH = join(XM_ROOT, 'config.json');
  let hadFile;
  let backup;

  beforeEach(() => {
    hadFile = existsSync(CONFIG_PATH);
    backup = hadFile ? readFileSync(CONFIG_PATH, 'utf8') : null;
  });

  afterEach(() => {
    if (hadFile) writeFileSync(CONFIG_PATH, backup);
    else { try { rmSync(CONFIG_PATH, { force: true }); } catch {} }
  });

  it('cross_vendor: _set writes one leaf, sibling leaves survive', async () => {
    writeJSON(CONFIG_PATH, { cross_vendor: { build: true, op: false } });
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { 'cross_vendor.eval': true } }),
    });
    expect(patchRes.status).toBe(200);

    const { body } = await getJSON('/api/config');
    expect(body.cross_vendor.eval).toBe(true);   // the leaf _set targeted
    expect(body.cross_vendor.build).toBe(true);  // sibling, must survive
    expect(body.cross_vendor.op).toBe(false);    // sibling, must survive
  });

  it('gates: _set writes one leaf, sibling leaves survive', async () => {
    writeJSON(CONFIG_PATH, { gates: { 'plan-exit': 'warn', 'verify-exit': 'block' } });
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // 'quality' is a valid gates.research-exit enum value (R9 now validates it).
      body: JSON.stringify({ _set: { 'gates.research-exit': 'quality' } }),
    });
    expect(patchRes.status).toBe(200);

    const { body } = await getJSON('/api/config');
    expect(body.gates['research-exit']).toBe('quality');  // the leaf _set targeted
    expect(body.gates['plan-exit']).toBe('warn');      // sibling, must survive
    expect(body.gates['verify-exit']).toBe('block');   // sibling, must survive
  });

  it('budget: _set writes one leaf, sibling leaves survive', async () => {
    writeJSON(CONFIG_PATH, { budget: { max_usd: 5, window_hours: 24 } });
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { 'budget.projects': { 'x-kit': { max_usd: 2 } } } }),
    });
    expect(patchRes.status).toBe(200);

    const { body } = await getJSON('/api/config');
    expect(body.budget.projects).toEqual({ 'x-kit': { max_usd: 2 } }); // the leaf _set targeted
    expect(body.budget.max_usd).toBe(5);           // sibling, must survive
    expect(body.budget.window_hours).toBe(24);     // sibling, must survive
  });

  it('worktree: _set writes one leaf, sibling leaves survive', async () => {
    writeJSON(CONFIG_PATH, { worktree: { enabled: true, base: 'main', max_parallel: 3 } });
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { 'worktree.branch_prefix': 'wt/' } }),
    });
    expect(patchRes.status).toBe(200);

    const { body } = await getJSON('/api/config');
    expect(body.worktree.branch_prefix).toBe('wt/');  // the leaf _set targeted
    expect(body.worktree.enabled).toBe(true);         // sibling, must survive
    expect(body.worktree.base).toBe('main');          // sibling, must survive
    expect(body.worktree.max_parallel).toBe(3);       // sibling, must survive
  });
});

describe('GET/PATCH /api/config?tier=build-local round trip (R2, config-gap-close)', () => {
  // Current server maps every tier other than 'global' to the project-tier
  // file, so a build-local PATCH can land in .xm/config.json until R2 fixes
  // the mapping. Guard both paths so a real project config is never mutated.
  const PROJECT_CONFIG_PATH = join(XM_ROOT, 'config.json');
  const BUILD_LOCAL_PATH = join(XM_ROOT, 'build', 'config.json');
  let projectHadFile, projectBackup;
  let buildLocalHadFile, buildLocalBackup;

  beforeEach(() => {
    projectHadFile = existsSync(PROJECT_CONFIG_PATH);
    projectBackup = projectHadFile ? readFileSync(PROJECT_CONFIG_PATH, 'utf8') : null;
    buildLocalHadFile = existsSync(BUILD_LOCAL_PATH);
    buildLocalBackup = buildLocalHadFile ? readFileSync(BUILD_LOCAL_PATH, 'utf8') : null;
  });

  afterEach(() => {
    if (projectHadFile) writeFileSync(PROJECT_CONFIG_PATH, projectBackup);
    else { try { rmSync(PROJECT_CONFIG_PATH, { force: true }); } catch {} }
    if (buildLocalHadFile) writeFileSync(BUILD_LOCAL_PATH, buildLocalBackup);
    else { try { rmSync(BUILD_LOCAL_PATH, { force: true, recursive: true }); } catch {} }
  });

  it('reports _empty:true and _tier:"build-local" when .xm/build/config.json is absent', async () => {
    try { rmSync(BUILD_LOCAL_PATH, { force: true }); } catch {}
    const { res, body } = await getJSON('/api/config?tier=build-local');
    expect(res.status).toBe(200);
    expect(body._empty).toBe(true);
    expect(body._tier).toBe('build-local');
  });

  it('round-trips worktree.enabled through a build-local PATCH + re-GET', async () => {
    const patchRes = await fetch(`${BASE}/api/config?tier=build-local`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { 'worktree.enabled': true } }),
    });
    expect(patchRes.status).toBe(200);

    const { body } = await getJSON('/api/config?tier=build-local');
    expect(body._tier).toBe('build-local');
    expect(body.worktree.enabled).toBe(true);

    // Contract requires the write to actually land in .xm/build/config.json,
    // not silently alias to the project tier (P1/R2).
    expect(existsSync(BUILD_LOCAL_PATH)).toBe(true);
    const onDisk = JSON.parse(readFileSync(BUILD_LOCAL_PATH, 'utf8'));
    expect(onDisk.worktree?.enabled).toBe(true);
  });
});

// ── R6/R8/R9: PATCH /api/config server write contract (t5, config-gap-close) ─
//
// If-Match optimistic concurrency (R6), _set guards (mutual exclusion + key-
// path validation against prototype pollution), schema validation (R9), and
// worktree.* shadow warnings (R8). All cases write to the real project tier
// (.xm/config.json) or build-local tier (.xm/build/config.json), so every
// block backs up and restores around each case (same pattern as the R2/R7
// blocks above).

describe('PATCH /api/config — If-Match optimistic concurrency (R6, config-gap-close)', () => {
  const CONFIG_PATH = join(XM_ROOT, 'config.json');
  let hadFile, backup;

  beforeEach(() => {
    hadFile = existsSync(CONFIG_PATH);
    backup = hadFile ? readFileSync(CONFIG_PATH, 'utf8') : null;
    writeJSON(CONFIG_PATH, { mode: 'developer' });
  });

  afterEach(() => {
    if (hadFile) writeFileSync(CONFIG_PATH, backup);
    else { try { rmSync(CONFIG_PATH, { force: true }); } catch {} }
  });

  it('accepts a write whose If-Match matches the current ETag', async () => {
    const { res } = await getJSON('/api/config');
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();

    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': etag },
      body: JSON.stringify({ _set: { agent_max_count: 6 } }),
    });
    expect(patchRes.status).toBe(200);
  });

  it('rejects a stale If-Match with 409 and leaves the file on disk unchanged', async () => {
    const before = readFileSync(CONFIG_PATH, 'utf8');
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"stale-0-0"' },
      body: JSON.stringify({ _set: { agent_max_count: 9 } }),
    });
    expect(patchRes.status).toBe(409);
    const body = await patchRes.json();
    expect(body.error).toBe('conflict');
    expect(typeof body.current_etag).toBe('string');
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(before); // rejected before any write
  });

  it('treats a garbage (non-ETag-shaped) If-Match value the same way — 409, not a crash', async () => {
    const before = readFileSync(CONFIG_PATH, 'utf8');
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': 'not-even-a-quoted-etag' },
      body: JSON.stringify({ _set: { agent_max_count: 9 } }),
    });
    expect(patchRes.status).toBe(409);
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(before);
  });
});

describe('PATCH /api/config — _set guards: mutual exclusion + key-path validation (R7/R9, config-gap-close)', () => {
  const CONFIG_PATH = join(XM_ROOT, 'config.json');
  let hadFile, backup;

  beforeEach(() => {
    hadFile = existsSync(CONFIG_PATH);
    backup = hadFile ? readFileSync(CONFIG_PATH, 'utf8') : null;
  });

  afterEach(() => {
    if (hadFile) writeFileSync(CONFIG_PATH, backup);
    else { try { rmSync(CONFIG_PATH, { force: true }); } catch {} }
  });

  function diskSnapshot() {
    return existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : null;
  }

  it("400s when a _set key's top-level ancestor also appears as a shallow-merge key", async () => {
    const before = diskSnapshot();
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { 'worktree.branch_prefix': 'wt/' }, worktree: { enabled: true } }),
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json();
    expect(body.error).toBe('set_toplevel_conflict');
    expect(diskSnapshot()).toBe(before); // rejected before any write
  });

  // The request is rejected (400) before setNestedKey ever runs, which is what
  // actually prevents Object.prototype pollution — verified here by asserting
  // the file on disk is untouched (a real assignment via `cur['__proto__'] =
  // {}` would otherwise happen inside the write path this 400 short-circuits).
  it('400s on a __proto__ segment', async () => {
    const before = diskSnapshot();
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { '__proto__.polluted_t5': true } }),
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json();
    expect(body.error).toBe('invalid_set_key');
    expect(diskSnapshot()).toBe(before);
  });

  it('400s on a constructor.prototype segment', async () => {
    const before = diskSnapshot();
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { 'constructor.prototype.polluted_t5b': true } }),
    });
    expect(patchRes.status).toBe(400);
    expect(diskSnapshot()).toBe(before);
  });

  it('400s on an empty path segment (a..b)', async () => {
    const before = diskSnapshot();
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { 'a..b': 1 } }),
    });
    expect(patchRes.status).toBe(400);
    const body = await patchRes.json();
    expect(body.error).toBe('invalid_set_key');
    expect(diskSnapshot()).toBe(before);
  });
});

describe('PATCH /api/config — R9 schema validation (422) + unregistered-key escape hatch (config-gap-close)', () => {
  const CONFIG_PATH = join(XM_ROOT, 'config.json');
  let hadFile, backup;

  beforeEach(() => {
    hadFile = existsSync(CONFIG_PATH);
    backup = hadFile ? readFileSync(CONFIG_PATH, 'utf8') : null;
  });

  afterEach(() => {
    if (hadFile) writeFileSync(CONFIG_PATH, backup);
    else { try { rmSync(CONFIG_PATH, { force: true }); } catch {} }
  });

  it('422s a registered top-level key with an invalid enum value, and does not write', async () => {
    const before = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : null;
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'not-a-real-mode' }),
    });
    expect(patchRes.status).toBe(422);
    const body = await patchRes.json();
    expect(body.error).toBe('validation_failed');
    expect(body.violations.some((v) => v.key === 'mode')).toBe(true);
    expect(existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : null).toBe(before);
  });

  it('422s a _set dotted-key with an invalid enum value', async () => {
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { mode: 'also-not-real' } }),
    });
    expect(patchRes.status).toBe(422);
    const body = await patchRes.json();
    expect(body.error).toBe('validation_failed');
    expect(body.violations.some((v) => v.key === 'mode')).toBe(true);
  });

  it('allows (200) an unregistered top-level key — warn, not block (C4 escape hatch)', async () => {
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totally_unregistered_key_xyz_t5: 123 }),
    });
    expect(patchRes.status).toBe(200);
    const { body } = await getJSON('/api/config');
    expect(body.totally_unregistered_key_xyz_t5).toBe(123);
  });
});

describe('PATCH /api/config — worktree.* shadow warnings (R8, config-gap-close)', () => {
  const PROJECT_CONFIG_PATH = join(XM_ROOT, 'config.json');
  const BUILD_LOCAL_PATH = join(XM_ROOT, 'build', 'config.json');
  let projectHadFile, projectBackup;
  let buildLocalHadFile, buildLocalBackup;

  beforeEach(() => {
    projectHadFile = existsSync(PROJECT_CONFIG_PATH);
    projectBackup = projectHadFile ? readFileSync(PROJECT_CONFIG_PATH, 'utf8') : null;
    buildLocalHadFile = existsSync(BUILD_LOCAL_PATH);
    buildLocalBackup = buildLocalHadFile ? readFileSync(BUILD_LOCAL_PATH, 'utf8') : null;

    // build-local (highest-priority tier) already sets worktree.max_parallel —
    // writing the SAME key at a lower-priority tier should come back shadowed.
    mkdirSync(dirname(BUILD_LOCAL_PATH), { recursive: true });
    writeJSON(BUILD_LOCAL_PATH, { worktree: { max_parallel: 7 } });
  });

  afterEach(() => {
    if (projectHadFile) writeFileSync(PROJECT_CONFIG_PATH, projectBackup);
    else { try { rmSync(PROJECT_CONFIG_PATH, { force: true }); } catch {} }
    if (buildLocalHadFile) writeFileSync(BUILD_LOCAL_PATH, buildLocalBackup);
    else { try { rmSync(BUILD_LOCAL_PATH, { force: true, recursive: true }); } catch {} }
  });

  it('reports shadowed_by when a project-tier (default tier) _set write is shadowed by build-local', async () => {
    const patchRes = await fetch(`${BASE}/api/config`, { // no ?tier= → default 'project' tier
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { 'worktree.max_parallel': 3 } }),
    });
    expect(patchRes.status).toBe(200);
    const body = await patchRes.json();
    expect(Array.isArray(body.shadowed_by)).toBe(true);
    const entry = body.shadowed_by.find((s) => s.key === 'worktree.max_parallel');
    expect(entry).toBeTruthy();
    expect(entry.tiers).toContain('build-local');

    // Warning only — the write still proceeds; the project tier is really updated.
    const { body: cfg } = await getJSON('/api/config');
    expect(cfg.worktree.max_parallel).toBe(3);
  });

  it('build-local writes are never shadowed (it is the highest-priority tier)', async () => {
    const patchRes = await fetch(`${BASE}/api/config?tier=build-local`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { 'worktree.max_parallel': 9 } }),
    });
    expect(patchRes.status).toBe(200);
    const body = await patchRes.json();
    expect(body.shadowed_by).toBeUndefined();
  });
});

// ── R14 (c)-(g) gap close (t8, config-gap-close) ──────────────────────────
//
// Fills the remaining gaps identified against PRD phases/02-plan/PRD.md R14
// after t1/t4/t5/t6 landed their coverage:
//   (c) If-Match concurrency — t5 only exercised a single PATCH against a
//       hardcoded stale ETag string; nothing modeled the real race (two
//       writers reading the same live ETag, one lands, the other's now-stale
//       token gets rejected). Added below.
//   (d) GET /api/config/schema contract — already covered (t4: length/group/
//       runtime_default). Not duplicated here.
//   (e) 422 — t5 only covered enum violations end-to-end over HTTP; type/min/
//       max/non-nullable-null were unit-tested against validateSet() directly
//       (config-cli.test.mjs, t2) but never asserted through the actual PATCH
//       endpoint. Added below.
//   (f) WORKTREE_CONFIG_DEFAULTS <-> config-schema worktree.* sync — added in
//       test/config-cli.test.mjs (unit-level, alongside the other schema/
//       shared-config assertions), not here.
//   (g) shadow warnings — already covered (t1/t5). Not duplicated here.
// Plus: oversized-body 413, _delete-before-_set ordering, and schema ETag/304
// — none of which had any prior coverage.

describe('GET /api/config/schema — ETag / If-None-Match (304, R14 gap)', () => {
  it('returns a stable ETag across repeat GETs of the same body', async () => {
    const first = await fetch(`${BASE}/api/config/schema`);
    const etag1 = first.headers.get('etag');
    expect(etag1).toBeTruthy();
    await first.json();

    const second = await fetch(`${BASE}/api/config/schema`);
    expect(second.headers.get('etag')).toBe(etag1);
  });

  it('returns 304 with an empty body when If-None-Match matches the current ETag', async () => {
    const first = await fetch(`${BASE}/api/config/schema`);
    const etag = first.headers.get('etag');
    await first.json();

    const res = await fetch(`${BASE}/api/config/schema`, {
      headers: { 'If-None-Match': etag },
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
  });

  it('returns 200 with the full entry list when If-None-Match does not match', async () => {
    const res = await fetch(`${BASE}/api/config/schema`, {
      headers: { 'If-None-Match': '"stale-etag-t8"' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.length).toBe(SCHEMA.length);
  });
});

describe('PATCH /api/config — concurrent PATCH race (R14c, config-gap-close)', () => {
  const CONFIG_PATH = join(XM_ROOT, 'config.json');
  let hadFile, backup;

  beforeEach(() => {
    hadFile = existsSync(CONFIG_PATH);
    backup = hadFile ? readFileSync(CONFIG_PATH, 'utf8') : null;
    writeJSON(CONFIG_PATH, { mode: 'developer', agent_max_count: 4 });
  });

  afterEach(() => {
    if (hadFile) writeFileSync(CONFIG_PATH, backup);
    else { try { rmSync(CONFIG_PATH, { force: true }); } catch {} }
  });

  it('a second writer holding the same now-stale ETag gets 409, and the file holds exactly the first writer\'s result', async () => {
    // Both "users" open the editor at the same time and read the same ETag.
    const { res: getRes } = await getJSON('/api/config');
    const sharedEtag = getRes.headers.get('etag');
    expect(sharedEtag).toBeTruthy();

    // Writer A saves first — succeeds, file now reflects A's change.
    const patchA = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': sharedEtag },
      body: JSON.stringify({ _set: { agent_max_count: 7 } }),
    });
    expect(patchA.status).toBe(200);
    const afterA = readFileSync(CONFIG_PATH, 'utf8');

    // Writer B never refreshed — still holds the ORIGINAL ETag, now stale
    // because A's write already landed.
    const patchB = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': sharedEtag },
      body: JSON.stringify({ _set: { agent_max_count: 9 } }),
    });
    expect(patchB.status).toBe(409);
    const bodyB = await patchB.json();
    expect(bodyB.error).toBe('conflict');

    // File is exactly A's result — B's rejected write left no trace.
    expect(readFileSync(CONFIG_PATH, 'utf8')).toBe(afterA);
    expect(JSON.parse(afterA).agent_max_count).toBe(7);
  });
});

describe('PATCH /api/config — R9 422 type matrix over HTTP (R14e, config-gap-close)', () => {
  // config-cli.test.mjs (t2) already unit-tests validateSet() directly for
  // each of these codes; these cases confirm the same violations actually
  // reach the client as a 422 through the real PATCH endpoint, with the
  // structured { key, code, severity } shape the dashboard's inline UI reads.
  const CONFIG_PATH = join(XM_ROOT, 'config.json');
  let hadFile, backup;

  beforeEach(() => {
    hadFile = existsSync(CONFIG_PATH);
    backup = hadFile ? readFileSync(CONFIG_PATH, 'utf8') : null;
  });

  afterEach(() => {
    if (hadFile) writeFileSync(CONFIG_PATH, backup);
    else { try { rmSync(CONFIG_PATH, { force: true }); } catch {} }
  });

  function diskSnapshot() {
    return existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : null;
  }

  it('422s a type violation (agent_max_count set to a string) via _set', async () => {
    const before = diskSnapshot();
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { agent_max_count: 'not-a-number' } }),
    });
    expect(patchRes.status).toBe(422);
    const body = await patchRes.json();
    expect(body.error).toBe('validation_failed');
    const v = body.violations.find((f) => f.key === 'agent_max_count' && f.code === 'type');
    expect(v).toBeDefined();
    expect(v.severity).toBe('error');
    expect(diskSnapshot()).toBe(before);
  });

  it('422s a min violation (agent_max_count below range) via _set', async () => {
    const before = diskSnapshot();
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { agent_max_count: 0 } }),
    });
    expect(patchRes.status).toBe(422);
    const body = await patchRes.json();
    const v = body.violations.find((f) => f.key === 'agent_max_count' && f.code === 'min');
    expect(v).toBeDefined();
    expect(v.severity).toBe('error');
    expect(diskSnapshot()).toBe(before);
  });

  it('422s a max violation (agent_max_count above range) via _set', async () => {
    const before = diskSnapshot();
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _set: { agent_max_count: 999 } }),
    });
    expect(patchRes.status).toBe(422);
    const body = await patchRes.json();
    const v = body.violations.find((f) => f.key === 'agent_max_count' && f.code === 'max');
    expect(v).toBeDefined();
    expect(v.severity).toBe('error');
    expect(diskSnapshot()).toBe(before);
  });

  it('422s a null value against a non-nullable registered key (mode) via top-level PATCH', async () => {
    const before = diskSnapshot();
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: null }),
    });
    expect(patchRes.status).toBe(422);
    const body = await patchRes.json();
    const v = body.violations.find((f) => f.key === 'mode' && f.code === 'type');
    expect(v).toBeDefined();
    expect(v.severity).toBe('error');
    expect(diskSnapshot()).toBe(before);
  });
});

describe('PATCH /api/config — oversized body guard (413, config-gap-close)', () => {
  const CONFIG_PATH = join(XM_ROOT, 'config.json');
  let hadFile, backup;

  beforeEach(() => {
    hadFile = existsSync(CONFIG_PATH);
    backup = hadFile ? readFileSync(CONFIG_PATH, 'utf8') : null;
  });

  afterEach(() => {
    if (hadFile) writeFileSync(CONFIG_PATH, backup);
    else { try { rmSync(CONFIG_PATH, { force: true }); } catch {} }
  });

  it('413s a body whose JSON exceeds the 256KB guard, and does not write', async () => {
    const before = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : null;
    const hugeValue = 'x'.repeat(300 * 1024); // > CONFIG_MAX_BYTES (256KB) once stringified
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totally_unregistered_key_huge_t8: hugeValue }),
    });
    expect(patchRes.status).toBe(413);
    const body = await patchRes.json();
    expect(body.error).toBe('too_large');
    expect(typeof body.max_bytes).toBe('number');
    expect(existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf8') : null).toBe(before);
  });
});

describe('PATCH /api/config — _delete applied before _set (R7 ordering, config-gap-close)', () => {
  const CONFIG_PATH = join(XM_ROOT, 'config.json');
  let hadFile, backup;

  beforeEach(() => {
    hadFile = existsSync(CONFIG_PATH);
    backup = hadFile ? readFileSync(CONFIG_PATH, 'utf8') : null;
  });

  afterEach(() => {
    if (hadFile) writeFileSync(CONFIG_PATH, backup);
    else { try { rmSync(CONFIG_PATH, { force: true }); } catch {} }
  });

  it('deleting a whole subtree then _set-ing a leaf under it recreates ONLY that leaf', async () => {
    // Decisive ordering probe: if _set ran first it would write cross_vendor.build
    // into the existing object, and the later _delete of the whole 'cross_vendor'
    // key would then wipe that write too, leaving cross_vendor entirely absent.
    // Since the contract is _delete-then-_set, the delete empties the subtree
    // FIRST and _set recreates a fresh object with only the leaf it targeted.
    writeJSON(CONFIG_PATH, { cross_vendor: { build: true, op: false, eval: true } });
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _delete: ['cross_vendor'], _set: { 'cross_vendor.build': true } }),
    });
    expect(patchRes.status).toBe(200);

    const { body } = await getJSON('/api/config');
    expect(body.cross_vendor).toEqual({ build: true });
  });

  it('a _delete on one leaf and a _set on a sibling leaf in the same body both apply, independently', async () => {
    writeJSON(CONFIG_PATH, { gates: { 'plan-exit': 'human-verify', 'verify-exit': 'quality' } });
    const patchRes = await fetch(`${BASE}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _delete: ['gates.verify-exit'], _set: { 'gates.plan-exit': 'quality' } }),
    });
    expect(patchRes.status).toBe(200);

    const { body } = await getJSON('/api/config');
    expect(body.gates['plan-exit']).toBe('quality');     // _set applied
    expect(body.gates['verify-exit']).toBeUndefined();    // _delete applied, not resurrected
  });
});
