/**
 * Dashboard pricing sync guard (t9, R9)
 *
 * Proves the dashboard serves the SAME prices as cost-engine's MODEL_COSTS.
 * Before this guard the dashboard kept a hand-copied MODEL_PRICING table that
 * had already drifted (haiku input 0.80 vs cost-engine 1.00). This test spawns
 * the real server against a temp workspace whose trace holds exactly 1M input +
 * 1M output tokens per tier, then asserts the served /api/costs breakdown equals
 * MODEL_COSTS[tier] (USD per 1M). It also verifies the routing endpoint derives
 * its tier list + vendor_models from cost-engine instead of a hardcode.
 *
 * Design: the server starts Bun.serve at module load, so it is spawned as a
 * subprocess (mirrors x-dashboard/test/api.test.mjs) rather than imported. HOME
 * is redirected to the temp dir so the global PID file / project registry stay
 * isolated from any real dashboard instance.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_PATH = join(REPO_ROOT, 'x-dashboard', 'lib', 'x-dashboard-server.mjs');
// The dashboard resolves this same source cost-engine when run from the repo
// (getCostEngine's second candidate); importing it here compares like-for-like.
const COST_ENGINE_PATH = join(REPO_ROOT, 'x-build', 'lib', 'x-build', 'cost-engine.mjs');
const TEST_PORT = 19899;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const MILLION = 1_000_000;

// Realistic model IDs so resolveModelKey's substring match is exercised too.
const TIER_MODEL_ID = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-5',
  opus: 'claude-opus-4-1',
};

let MODEL_COSTS;
let VENDOR_MODELS;
let serverProc;
let tmpRoot;

beforeAll(async () => {
  ({ MODEL_COSTS, VENDOR_MODELS } = await import(COST_ENGINE_PATH));

  // Temp workspace: .xm/traces/<trace>.jsonl with 1M/1M tokens per tier.
  tmpRoot = mkdtempSync(join(tmpdir(), 'xm-dash-pricing-'));
  const tracesDir = join(tmpRoot, '.xm', 'traces');
  mkdirSync(tracesDir, { recursive: true });

  const lines = [
    JSON.stringify({ type: 'session_start', timestamp: '2026-07-01T00:00:00.000Z' }),
    ...Object.keys(MODEL_COSTS).map((tier) => JSON.stringify({
      type: 'agent_call',
      timestamp: '2026-07-01T00:00:01.000Z',
      model: TIER_MODEL_ID[tier] ?? tier,
      input_tokens_est: MILLION,
      output_tokens_est: MILLION,
    })),
    JSON.stringify({ type: 'session_end', timestamp: '2026-07-01T00:00:02.000Z' }),
  ];
  writeFileSync(join(tracesDir, 'pricing-guard-20260701-000000.jsonl'), lines.join('\n') + '\n');

  serverProc = spawn('bun', [SERVER_PATH, '--port', String(TEST_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    cwd: tmpRoot,
    // HOME → tmpRoot isolates the global PID file, registry, and global config.
    env: { ...process.env, HOME: tmpRoot, NO_BROWSER: '1', CI: '1' },
  });
  serverProc.stderr?.on('data', () => {});
  serverProc.stdout?.on('data', () => {});

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${BASE}/health`); if (res.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('x-dashboard-server did not start within 8s');
});

afterAll(() => {
  try { serverProc?.kill('SIGTERM'); } catch {}
  try { if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe('dashboard pricing sync guard (t9, R9)', () => {
  test('served per-tier trace cost equals cost-engine MODEL_COSTS', async () => {
    const res = await fetch(`${BASE}/api/costs`);
    expect(res.ok).toBe(true);
    const body = await res.json();

    for (const [tier, price] of Object.entries(MODEL_COSTS)) {
      const served = body.byModel?.[tier];
      expect(served, `byModel is missing tier "${tier}"`).toBeTruthy();
      // 1M input + 1M output tokens → cost (USD) == price.input + price.output.
      // Old hardcoded haiku (0.80 input) would yield 4.80 here, not MODEL_COSTS' 6.00.
      const expected = price.input + price.output;
      expect(served.cost).toBeCloseTo(expected, 6);
    }
  });

  test('routing endpoint derives tiers + vendor_models from cost-engine (no hardcode)', async () => {
    const res = await fetch(`${BASE}/api/config/model-routing`);
    expect(res.ok).toBe(true);
    const body = await res.json();

    // Tier list must be exactly cost-engine's, not a literal ['haiku','sonnet','opus'].
    expect(body.models).toEqual(Object.keys(MODEL_COSTS));

    // vendor_models is additive: built-in defaults + effective resolution.
    expect(body.vendor_models).toBeTruthy();
    expect(body.vendor_models.defaults).toEqual(VENDOR_MODELS);
    // Under the default (empty) config, claude tiers resolve to themselves.
    expect(body.vendor_models.effective?.claude).toEqual(
      Object.fromEntries(Object.keys(MODEL_COSTS).map((t) => [t, t])),
    );
  });
});
