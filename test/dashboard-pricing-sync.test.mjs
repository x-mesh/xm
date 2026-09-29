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
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_PATH = join(REPO_ROOT, 'x-dashboard', 'lib', 'x-dashboard-server.mjs');
// The dashboard resolves this same source cost-engine when run from the repo
// (getCostEngine's second candidate); importing it here compares like-for-like.
const COST_ENGINE_PATH = join(REPO_ROOT, 'x-build', 'lib', 'x-build', 'cost-engine.mjs');
// Assigned in beforeAll: a fixed port collided with whatever else was listening
// on the machine, and the child's EADDRINUSE exit surfaced only as a 5s hook
// timeout while the poll kept hitting the foreign server's /health.
let TEST_PORT;
let BASE;
const MILLION = 1_000_000;

/** Ask the OS for a free loopback port. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

/** Poll /health; fail with the child's stderr as soon as it exits instead of timing out silently. */
async function waitForHealth(proc, base, timeoutMs) {
  let stderr = '';
  let exit = null;
  proc.stderr?.on('data', (chunk) => { stderr += chunk; });
  proc.stdout?.on('data', () => {});
  proc.on('exit', (code, signal) => { exit = { code, signal }; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exit) throw new Error(`x-dashboard-server exited before /health (code ${exit.code}, signal ${exit.signal}):\n${stderr.trim()}`);
    try { const res = await fetch(`${base}/health`); if (res.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`x-dashboard-server did not answer /health within ${timeoutMs}ms:\n${stderr.trim()}`);
}

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

  TEST_PORT = await freePort();
  BASE = `http://127.0.0.1:${TEST_PORT}`;
  serverProc = spawn('bun', [SERVER_PATH, '--port', String(TEST_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    cwd: tmpRoot,
    // HOME → tmpRoot isolates the global PID file, registry, and global config.
    env: { ...process.env, HOME: tmpRoot, NO_BROWSER: '1', CI: '1' },
  });

  // Under bun's 5s hook timeout, so a startup failure is reported by name.
  await waitForHealth(serverProc, BASE, 4000);
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

  test('FALLBACK_MODEL_COSTS in the server source equals cost-engine MODEL_COSTS', () => {
    // The fallback table is only served when the cost-engine import fails, so
    // the live-server assertions above never exercise it — it drifted exactly
    // this way once (opus stayed at the pre-2026-08 $15/$75 rate). Parse it out
    // of the source text and pin it to MODEL_COSTS.
    const src = readFileSync(SERVER_PATH, 'utf8');
    const match = src.match(/const FALLBACK_MODEL_COSTS = \{([\s\S]*?)\n\};/);
    expect(match, 'FALLBACK_MODEL_COSTS literal not found in server source').toBeTruthy();
    const fallback = new Function(`return {${match[1]}};`)();
    expect(fallback).toEqual({ ...MODEL_COSTS });
  });
});
