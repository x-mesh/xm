/** Budget Agent PreToolUse hook + reservation ledger (R24–R26). */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { activeReservations, checkAndReserve } from '../x-build/templates/hooks/budget-reservations.mjs';

const ROOT = join(import.meta.dirname, '..');
const HOOK = join(ROOT, 'x-build', 'templates', 'hooks', 'block-when-over-budget.mjs');
let DIR;

beforeEach(() => {
  DIR = mkdtempSync(join(tmpdir(), 'xb-budget-hook-'));
  mkdirSync(join(DIR, '.xm', 'build', 'metrics'), { recursive: true });
  writeFileSync(join(DIR, '.xm', 'config.json'), JSON.stringify({ budget: {
    enforce: true, max_usd: 0.04, reservation_usd: 0.01, reservation_ttl_ms: 1000,
  } }));
});
afterEach(() => rmSync(DIR, { recursive: true, force: true }));

function runHook(input, env = {}) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: DIR, ...env },
  });
}

function runHookAsync(input) {
  return new Promise((resolve) => {
    const child = spawn('node', [HOOK], { env: { ...process.env, CLAUDE_PROJECT_DIR: DIR }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('block-when-over-budget hook', () => {
  test('open circuit blocks a new Agent dispatch with actionable state, but ignores other tools', () => {
    const project = join(DIR, '.xm', 'build', 'projects', 'alpha');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'circuit-breaker.json'), JSON.stringify({ state: 'open', reason: 'budget', cooldown_until: null }));
    const blocked = runHook({ tool_name: 'Agent', tool_input: {} });
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('state=open');
    expect(blocked.stderr).toContain('spent=$');
    expect(blocked.stderr).toContain('cap=$');
    expect(blocked.stderr).toContain('recovers_at=');
    // PreToolUse only sees a new Agent invocation; no Stop/PostTool hook is
    // installed here, so in-flight work is never aborted by this guard.
    expect(runHook({ tool_name: 'Read', tool_input: {} }).status).toBe(0);
  });

  test('malformed hook payload and disabled enforcement are non-disruptive', () => {
    const malformed = spawnSync('node', [HOOK], { input: 'not-json', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: DIR } });
    expect(malformed.status).toBe(0);
    writeFileSync(join(DIR, '.xm', 'config.json'), JSON.stringify({ budget: { enforce: false, max_usd: 0.01 } }));
    expect(runHook({ tool_name: 'Agent', tool_input: {} }).status).toBe(0);
  });

  test('symlinked reservation storage makes the Agent hook fail closed without overwriting outside files', () => {
    const metrics = join(DIR, '.xm', 'build', 'metrics');
    const outside = mkdtempSync(join(tmpdir(), 'xb-budget-outside-hook-'));
    const marker = join(outside, 'marker.txt');
    writeFileSync(marker, 'must stay unchanged');
    rmSync(metrics, { recursive: true, force: true });
    symlinkSync(outside, metrics);
    try {
      const result = runHook({ tool_name: 'Agent', tool_input: {} });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unsafe_ledger_path');
      expect(readFileSync(marker, 'utf8')).toBe('must stay unchanged');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('ten concurrent Agent sessions reserve atomically without oversubscribing the cap', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => runHookAsync({ tool_name: 'Agent', tool_input: {} })));
    expect(results.filter((result) => result.code === 0)).toHaveLength(4);
    expect(results.filter((result) => result.code === 2)).toHaveLength(6);
    const rows = activeReservations(readFileSync(join(DIR, '.xm', 'build', 'metrics', 'reservations.jsonl'), 'utf8'));
    expect(rows).toHaveLength(4);
    expect(rows.reduce((sum, row) => sum + row.cost_usd, 0)).toBeCloseTo(0.04, 8);
  });
});

describe('reservation TTL + cleanup', () => {
  test('a reservation expires at the exact TTL boundary and stale/torn rows are compacted', () => {
    const ledger = join(DIR, '.xm', 'build', 'metrics', 'reservations.jsonl');
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const first = checkAndReserve({ filePath: ledger, cap: 0.01, spent: 0, amount: 0.01, ttl_ms: 10, now, reservation_id: 'one' });
    expect(first.ok).toBe(true);
    // Exact deadline means stale, not still active.
    const second = checkAndReserve({ filePath: ledger, cap: 0.01, spent: 0, amount: 0.01, ttl_ms: 10, now: now + 10, reservation_id: 'two' });
    expect(second.ok).toBe(true);
    const rows = activeReservations(readFileSync(ledger, 'utf8'), now + 10);
    expect(rows.map((row) => row.reservation_id)).toEqual(['two']);
    writeFileSync(ledger, readFileSync(ledger, 'utf8') + '{torn\n');
    const third = checkAndReserve({ filePath: ledger, cap: 0.02, spent: 0, amount: 0.01, ttl_ms: 10, now: now + 11, reservation_id: 'three' });
    expect(third.ok).toBe(true);
    expect(readFileSync(ledger, 'utf8')).not.toContain('{torn');
  });

  test('torn current ledger recovers a valid snapshot instead of losing an active reservation', () => {
    const ledger = join(DIR, '.xm', 'build', 'metrics', 'reservations.jsonl');
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(checkAndReserve({ filePath: ledger, cap: 0.01, spent: 0, amount: 0.01, ttl_ms: 1000, now, reservation_id: 'active' }).ok).toBe(true);
    writeFileSync(ledger, readFileSync(ledger, 'utf8') + '{torn\n');
    const blocked = checkAndReserve({ filePath: ledger, cap: 0.01, spent: 0, amount: 0.01, ttl_ms: 1000, now: now + 1, reservation_id: 'oversubscribe' });
    expect(blocked).toMatchObject({ ok: false, reason: 'cap_exceeded' });
    expect(activeReservations(readFileSync(ledger, 'utf8'), now + 1)).toHaveLength(1);
  });

  test('ambiguous corruption fails closed; crash during compaction recovers the pending journal without temp leaks', () => {
    const ledger = join(DIR, '.xm', 'build', 'metrics', 'reservations.jsonl');
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    writeFileSync(ledger, '{torn\n');
    expect(checkAndReserve({ filePath: ledger, cap: 0.01, spent: 0, amount: 0.01, ttl_ms: 1000, now })).toMatchObject({ ok: false, reason: 'ledger_corrupt' });
    rmSync(ledger, { force: true });
    expect(() => checkAndReserve({
      filePath: ledger, cap: 0.01, spent: 0, amount: 0.01, ttl_ms: 1000, now,
      onStage: (stage) => { if (stage === 'pending') throw new Error('simulated crash'); },
    })).toThrow('simulated crash');
    // Recovery counts the durable pending row; it may be conservative, but it
    // can never issue a second $0.01 dispatch against a $0.01 cap.
    expect(checkAndReserve({ filePath: ledger, cap: 0.01, spent: 0, amount: 0.01, ttl_ms: 1000, now: now + 1 })).toMatchObject({ ok: false, reason: 'cap_exceeded' });
    expect(activeReservations(readFileSync(ledger, 'utf8'), now + 1)).toHaveLength(1);
    expect(() => readFileSync(ledger + '.tmp', 'utf8')).toThrow();
    expect(() => readFileSync(ledger + '.bak.tmp', 'utf8')).toThrow();
    expect(() => readFileSync(ledger + '.pending.tmp', 'utf8')).toThrow();
  });

  test('a symlinked metrics directory fails closed without touching its external target', () => {
    const metrics = join(DIR, '.xm', 'build', 'metrics');
    const outside = mkdtempSync(join(tmpdir(), 'xb-budget-outside-'));
    const marker = join(outside, 'marker.txt');
    writeFileSync(marker, 'must stay unchanged');
    rmSync(metrics, { recursive: true, force: true });
    symlinkSync(outside, metrics);
    try {
      const result = checkAndReserve({ filePath: join(metrics, 'reservations.jsonl'), rootDir: DIR, cap: 0.01, spent: 0, amount: 0.01, ttl_ms: 1000 });
      expect(result).toMatchObject({ ok: false, reason: 'unsafe_ledger_path' });
      expect(readFileSync(marker, 'utf8')).toBe('must stay unchanged');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
