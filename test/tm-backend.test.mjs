/**
 * x-panel tm backend experiment (t8, docs/x-panel-term-mesh-phase2.md §6).
 * Stubbed tm-agent — no live term-mesh. Proves the MECHANICS only: capsule
 * routing + file handoff + subprocess fallback + timeout. The adoption gate
 * (≥20% p50, 0 JSON regressions) needs the live bench on a real machine:
 * x-panel/test/bench-tm-backend.mjs.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeViaTmPane, tmBackendAvailable, tmAgentCommand } from '../x-panel/lib/x-panel/tm-backend.mjs';

const CLI = join(import.meta.dirname, '..', 'x-panel', 'lib', 'x-panel-cli.mjs');
const STUB = join(import.meta.dirname, 'fixtures', 'panel-stub-model.mjs');
const TM_STUB = join(import.meta.dirname, 'fixtures', 'tm-agent-stub.mjs');

let DIR;
beforeAll(() => { DIR = mkdtempSync(join(tmpdir(), 'tm-backend-')); });
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function review(name, args = [], env = {}, tmAgents = { claude: 'reviewer', codex: 'explorer' }) {
  const sub = join(DIR, name);
  mkdirSync(join(sub, '.xm'), { recursive: true });
  writeFileSync(join(sub, '.xm', 'config.json'), JSON.stringify({ panel: { tm_agents: tmAgents } }));
  const log = join(DIR, `${name}.tm.jsonl`);
  const r = spawnSync('node', [CLI, 'review', 'some diff', '--models', 'claude,codex', '--backend', 'tm', ...args], {
    cwd: sub,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      X_PANEL_ROOT: join(sub, '.xm'),
      X_PANEL_GLOBAL_ROOT: join(sub, '.xm-g'),
      X_PANEL_CMD_CLAUDE: STUB,
      X_PANEL_CMD_CODEX: STUB,
      X_PANEL_TM_AGENT: TM_STUB,
      X_PANEL_TM_LOG: log,
      NO_COLOR: '1',
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const runDir = join(sub, '.xm', 'panel');
  const run = existsSync(runDir) ? readdirSync(runDir)[0] : null;
  const verdict = run ? JSON.parse(readFileSync(join(runDir, run, 'verdict.json'), 'utf8')) : null;
  const runFiles = run ? readdirSync(join(runDir, run)) : [];
  return { r, calls, verdict, runFiles };
}

describe('invokeViaTmPane (unit)', () => {
  test('delegates a capsule, polls the file, returns the provider result shape', async () => {
    const runDir = join(DIR, 'unit');
    mkdirSync(runDir, { recursive: true });
    const res = await invokeViaTmPane({
      agent: 'reviewer',
      prompt: 'Return findings JSON: {"findings":[...]}',
      runDir, label: 'claude', timeoutMs: 5000,
      env: { ...process.env, X_PANEL_TM_AGENT: TM_STUB },
    });
    expect(res.ok).toBe(true);
    expect(res.backend).toBe('tm');
    expect(res.json.findings.length).toBe(2);
    expect(existsSync(join(runDir, 'claude.tm.prompt.txt'))).toBe(true);
  });

  test('a rejected delegate fails loudly; a silent pane times out', async () => {
    const runDir = join(DIR, 'unit-fail');
    mkdirSync(runDir, { recursive: true });
    const rejected = await invokeViaTmPane({
      agent: 'reviewer', prompt: 'p', runDir, label: 'a', timeoutMs: 2000,
      env: { ...process.env, X_PANEL_TM_AGENT: TM_STUB, X_PANEL_TM_FAIL_DELEGATE: '1' },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('delegate failed');
    const hung = await invokeViaTmPane({
      agent: 'reviewer', prompt: 'p', runDir, label: 'b', timeoutMs: 800,
      env: { ...process.env, X_PANEL_TM_AGENT: TM_STUB, X_PANEL_TM_NO_OUTPUT: '1' },
    });
    expect(hung.ok).toBe(false);
    expect(hung.error).toContain('timeout');
  });

  test('tmAgentCommand honors the override; availability follows it', () => {
    expect(tmAgentCommand({ X_PANEL_TM_AGENT: TM_STUB })).toEqual(['node', [TM_STUB]]);
    expect(tmBackendAvailable({ X_PANEL_TM_AGENT: TM_STUB })).toBe(true);
    expect(tmBackendAvailable({ X_PANEL_TM_AGENT: '/definitely/missing' })).toBe(false);
  });
});

describe('review --backend tm (e2e, stubbed)', () => {
  test('mapped providers route via tm panes: 4 delegates, verdict produced, tm files in run dir', () => {
    const { r, calls, verdict, runFiles } = review('happy');
    expect(r.status).toBe(0);
    expect(calls.length).toBe(4); // 2 models × 2 rounds
    expect(new Set(calls.map((c) => c.agent))).toEqual(new Set(['reviewer', 'explorer']));
    expect(verdict.counts.unique).toBeGreaterThan(0);
    expect(runFiles.filter((f) => f.endsWith('.tm.json')).length).toBe(2); // per model (round 2 overwrites)
  });

  test('unmapped provider stays on the subprocess backend, loudly', () => {
    const { r, calls, verdict } = review('partial', [], {}, { claude: 'reviewer' });
    expect(r.status).toBe(0);
    expect(calls.every((c) => c.agent === 'reviewer')).toBe(true); // only claude delegated
    expect(calls.length).toBe(2);
    expect(r.stderr).toContain('no panel.tm_agents mapping for "codex"');
    expect(verdict.counts.unique).toBeGreaterThan(0);
  });

  test('tm-agent unavailable falls back entirely to subprocess, loudly', () => {
    const { r, calls, verdict } = review('unavailable', [], { X_PANEL_TM_AGENT: '/definitely/missing' });
    expect(r.status).toBe(0);
    expect(calls.length).toBe(0);
    expect(r.stderr).toContain('tm-agent is not available');
    expect(verdict.counts.unique).toBeGreaterThan(0);
  });
});
