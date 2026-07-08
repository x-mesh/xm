/**
 * x-panel round-2 session reuse (t5, docs/x-panel-term-mesh-phase2.md R4).
 * Stubbed providers. Proves: round 1 creates sessions (claude uuid, codex
 * banner capture), round 2 resumes them with a TARGET-free delta prompt, a
 * broken resume falls back stateless LOUDLY (resume:"fallback" in the verdict,
 * findings unchanged), and --no-session-reuse keeps everything stateless.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionCommand, buildCodexResumeArgs, supportsResume } from '../x-panel/lib/x-panel/adapters.mjs';

const CLI = join(import.meta.dirname, '..', 'x-panel', 'lib', 'x-panel-cli.mjs');
const STUB = join(import.meta.dirname, 'fixtures', 'panel-stub-model.mjs');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let DIR;
beforeAll(() => { DIR = mkdtempSync(join(tmpdir(), 'session-reuse-')); });
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function review(name, args = [], env = {}) {
  const sub = join(DIR, name);
  const log = join(DIR, `${name}.session.jsonl`);
  const r = spawnSync('node', [CLI, 'review', 'some diff', '--models', 'claude,codex', ...args], {
    cwd: DIR,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      X_PANEL_ROOT: join(sub, '.xm'),
      X_PANEL_GLOBAL_ROOT: join(sub, '.xm-g'),
      X_PANEL_CMD_CLAUDE: STUB,
      X_PANEL_CMD_CODEX: STUB,
      X_PANEL_SESSION_LOG: log,
      NO_COLOR: '1',
      ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const runDir = join(sub, '.xm', 'panel');
  const run = existsSync(runDir) ? readdirSync(runDir)[0] : null;
  const verdict = run ? JSON.parse(readFileSync(join(runDir, run, 'verdict.json'), 'utf8')) : null;
  return { r, calls, verdict };
}

describe('resolveSessionCommand (argv shapes)', () => {
  test('claude create/resume argv; codex resume via buildCodexResumeArgs; no --last ever', () => {
    delete process.env.X_PANEL_CMD_CLAUDE; // exercise the REAL argv, not the stub override
    delete process.env.X_PANEL_CMD_CODEX;
    const id = '11111111-2222-4333-8444-555555555555';
    expect(resolveSessionCommand('claude', 'p', 'haiku', { mode: 'create', id }))
      .toEqual(['claude', ['-p', '--model', 'haiku', '--session-id', id, 'p']]);
    expect(resolveSessionCommand('claude', 'p', null, { mode: 'resume', id }))
      .toEqual(['claude', ['-p', '--resume', id, 'p']]);
    expect(resolveSessionCommand('codex', 'p', null, { mode: 'resume', id }))
      .toEqual(buildCodexResumeArgs({ execFlags: ['--sandbox', 'read-only', '--skip-git-repo-check'], sessionId: id, prompt: 'p' }));
    // codex create = plain exec (session implicit, id captured from the banner)
    expect(resolveSessionCommand('codex', 'p', null, { mode: 'create', id: null })[1]).not.toContain('resume');
    // resume without an id is a caller bug, never --last (wrong-session splice is silent)
    expect(resolveSessionCommand('codex', 'p', null, { mode: 'resume', id: null })).toBeNull();
    // non-resume providers ignore session
    expect(resolveSessionCommand('agy', 'p', null, { mode: 'create', id })).toEqual(resolveSessionCommand('agy', 'p', null, null));
    expect(supportsResume('claude') && supportsResume('codex')).toBe(true);
    expect(supportsResume('agy')).toBe(false);
  });
});

describe('review with session reuse (default on)', () => {
  test('round 1 creates, round 2 resumes with a TARGET-free prompt; verdict records resume:ok', () => {
    const { r, calls, verdict } = review('happy');
    expect(r.status).toBe(0);

    const claude = calls.filter((c) => c.model === 'claude');
    expect(claude.length).toBe(2);
    expect(claude[0]).toMatchObject({ refute: false, mode: 'create' });
    expect(claude[0].id).toMatch(UUID_RE);
    expect(claude[1]).toMatchObject({ refute: true, mode: 'resume', id: claude[0].id, hasTarget: false });
    expect(claude[0].hasTarget).toBe(true); // round 1 still carries the target

    const codex = calls.filter((c) => c.model === 'codex');
    expect(codex[0]).toMatchObject({ refute: false, mode: 'create', id: null });
    expect(codex[1]).toMatchObject({ refute: true, mode: 'resume', hasTarget: false });
    expect(codex[1].id).toBe('123e4567-e89b-42d3-a456-426614174000'); // captured from the banner

    expect(verdict.usage.by_model.claude.resume).toBe('ok');
    expect(verdict.usage.by_model.codex.resume).toBe('ok');
    expect(verdict.counts.unique).toBeGreaterThan(0);
  });

  test('broken resume falls back stateless and is recorded as resume:fallback', () => {
    const base = review('baseline');
    const { r, calls, verdict } = review('fallback', [], { X_PANEL_FAIL_RESUME_CLAUDE: '1' });
    expect(r.status).toBe(0);
    // the failed resume attempt is followed by a stateless full-prompt retry
    const claudeRefutes = calls.filter((c) => c.model === 'claude' && c.refute);
    expect(claudeRefutes.length).toBe(2);
    expect(claudeRefutes[0].mode).toBe('resume');
    expect(claudeRefutes[1]).toMatchObject({ mode: null, hasTarget: true });
    expect(verdict.usage.by_model.claude.resume).toBe('fallback');
    expect(verdict.usage.by_model.codex.resume).toBe('ok');
    // findings unchanged vs the happy-path baseline (R4)
    expect(verdict.counts).toEqual(base.verdict.counts);
  });

  test('--no-session-reuse keeps every call stateless', () => {
    const { r, calls, verdict } = review('off', ['--no-session-reuse']);
    expect(r.status).toBe(0);
    expect(calls.every((c) => c.mode == null)).toBe(true);
    expect(calls.filter((c) => c.refute).every((c) => c.hasTarget)).toBe(true);
    expect(verdict.usage.by_model.claude.resume).toBe('stateless');
  });

  test('--stream disables session reuse (stream argv untouched)', () => {
    const { r, calls } = review('stream', ['--stream']);
    expect(r.status).toBe(0);
    expect(calls.every((c) => c.mode == null)).toBe(true);
  });
});
