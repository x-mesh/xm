import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'x-dashboard', 'lib', 'x-dashboard-server.mjs');
const PORT = 19903;
const BASE = `http://127.0.0.1:${PORT}`;
let proc;
let tmp;
let reviewDir;

const writeJSON = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2));
const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'xm-dash-review-gate-'));
  reviewDir = join(tmp, '.xm', 'review');
  mkdirSync(reviewDir, { recursive: true });
  proc = spawn('bun', [SERVER, '--port', String(PORT)], {
    cwd: tmp,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: tmp, XM_DASHBOARD_RUN_DIR: join(tmp, 'run'), NO_BROWSER: '1', CI: '1' },
  });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const res = await fetch(`${BASE}/health`); if (res.ok) return; } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error('dashboard did not start');
});

afterAll(() => {
  try { proc?.kill('SIGTERM'); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function seed({ gatePassed = false, gateFailures = ['Reviewed files changed since x-review'], mutateTriage = false } = {}) {
  const review = {
    reviewed_commit: 'abc1234',
    verdict: 'request_changes',
    findings: [{ severity: 'high', file: 'src/auth.ts', summary: 'auth bypass' }],
  };
  const triage = {
    reviewed_commit: 'abc1234',
    review_snapshot_digest: 'sha256:snapshot',
    target_findings: [{ id: 'F1', severity: 'high', file: 'src/auth.ts', decision: 'fix_now', evidence: 'reproduced' }],
    fix_scope: { allowed_files: ['src/auth.ts'] },
    verification: ['bun test auth'],
  };
  const gate = {
    reviewed_commit: 'abc1234',
    review_snapshot_digest: 'sha256:snapshot',
    passed: gatePassed,
    stage: gatePassed ? 'ready_for_fix' : 'blocked',
    failures: gateFailures,
    triage_digest: digest(triage),
  };
  if (mutateTriage) triage.target_findings[0].fix_notes = 'changed after gate';
  writeJSON(join(reviewDir, 'last-result.json'), review);
  writeJSON(join(reviewDir, 'triage.json'), triage);
  writeJSON(join(reviewDir, 'review-fix-gate.json'), gate);
  writeJSON(join(reviewDir, 'finding-lifecycle.json'), {
    schema: 1,
    findings: [{ id: 'F1', finding_id: 'rf_auth', state: gatePassed ? 'fix_authorized' : 'open', outcome: null, evidence: null }],
  });
}

describe('dashboard review-fix gate authority', () => {
  test('surfaces a CLI freshness failure instead of reporting ready', async () => {
    seed();
    const res = await fetch(`${BASE}/api/review/gate`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('blocked');
    expect(body.failures).toContain('Reviewed files changed since x-review');
    expect(body.gate).toMatchObject({ passed: false, stage: 'blocked' });
  });

  test('invalidates a passed receipt when triage bytes change', async () => {
    seed({ gatePassed: true, gateFailures: [], mutateTriage: true });
    const res = await fetch(`${BASE}/api/review/gate`);
    const body = await res.json();
    expect(body.status).toBe('blocked');
    expect(body.failures).toContain('triage changed since the last review-fix gate; run x-build verify-review-fix again');
  });

  test('invalidates a receipt from a different review snapshot at the same commit', async () => {
    seed({ gatePassed: true, gateFailures: [] });
    const gatePath = join(reviewDir, 'review-fix-gate.json');
    const staleGate = {
      reviewed_commit: 'abc1234',
      review_snapshot_digest: 'sha256:older-snapshot',
      passed: true,
      stage: 'ready_for_fix',
      failures: [],
      triage_digest: digest({
        reviewed_commit: 'abc1234',
        review_snapshot_digest: 'sha256:snapshot',
        target_findings: [{ id: 'F1', severity: 'high', file: 'src/auth.ts', decision: 'fix_now', evidence: 'reproduced' }],
        fix_scope: { allowed_files: ['src/auth.ts'] },
        verification: ['bun test auth'],
      }),
    };
    writeJSON(gatePath, staleGate);
    const body = await (await fetch(`${BASE}/api/review/gate`)).json();
    expect(body.status).toBe('blocked');
    expect(body.failures).toContain('review snapshot changed since the last review-fix gate; run x-build verify-review-fix again');
  });

  test('the project card understands the CLI receipt field names', async () => {
    const app = await Bun.file(join(ROOT, 'x-dashboard', 'public', 'app.js')).text();
    expect(app).toContain('rfGate.stage || rfGate.status');
    expect(app).toContain('rfGate.triage_required ?? rfGate.required_count');
    expect(app).toContain("rfStatus === 'ready_for_fix'");
    expect(app).toContain('rfGate.failures[0]');
    expect(app).toContain("f.lifecycle_state === 'reverified'");
  });

  test('surfaces finding lifecycle state and outcome', async () => {
    seed({ gatePassed: true, gateFailures: [] });
    writeJSON(join(reviewDir, 'finding-lifecycle.json'), {
      schema: 1,
      findings: [{ id: 'F1', finding_id: 'rf_auth', state: 'reverified', outcome: 'resolved', evidence: 'auth regression passes' }],
    });
    const body = await (await fetch(`${BASE}/api/review/gate`)).json();
    expect(body.required[0]).toMatchObject({ lifecycle_state: 'reverified', outcome: 'resolved', reverify_evidence: 'auth regression passes' });
  });

  test('invalidates a passed receipt when lifecycle bytes are edited', async () => {
    seed({ gatePassed: true, gateFailures: [] });
    const lifecyclePath = join(reviewDir, 'finding-lifecycle.json');
    const lifecycle = JSON.parse(await Bun.file(lifecyclePath).text());
    const gatePath = join(reviewDir, 'review-fix-gate.json');
    const gate = JSON.parse(await Bun.file(gatePath).text());
    gate.lifecycle_digest = digest(lifecycle);
    writeJSON(gatePath, gate);
    lifecycle.findings[0].state = 'reverified';
    writeJSON(lifecyclePath, lifecycle);
    const body = await (await fetch(`${BASE}/api/review/gate`)).json();
    expect(body.status).toBe('blocked');
    expect(body.failures).toContain('finding lifecycle changed since the last review-fix gate; run x-build verify-review-fix again');
  });
});
