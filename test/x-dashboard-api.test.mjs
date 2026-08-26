import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = resolve(import.meta.dirname, '..');
const SERVER = join(REPO, 'x-dashboard', 'lib', 'x-dashboard-server.mjs');
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), 'xdb-ledger-api-')));
const XM_ROOT = join(SANDBOX, '.xm');
const REVIEW_DIR = join(XM_ROOT, 'review');
const LEDGER = join(REVIEW_DIR, 'triage-ledger.jsonl');
const PORT = 23000 + (process.pid % 10000);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let serverError = '';

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function requestPrecision() {
  const response = await fetch(`${BASE}/api/review/precision`);
  return { response, body: await response.json() };
}

function resetLedger() {
  rmSync(LEDGER, { recursive: true, force: true });
}

function restoreReviewDir() {
  rmSync(REVIEW_DIR, { recursive: true, force: true });
  mkdirSync(REVIEW_DIR, { recursive: true });
}

beforeAll(async () => {
  mkdirSync(REVIEW_DIR, { recursive: true });
  server = spawn('bun', [SERVER, '--port', String(PORT)], {
    cwd: SANDBOX,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HOME: join(SANDBOX, 'home'),
      XM_DASHBOARD_RUN_DIR: join(SANDBOX, 'run'),
      NO_BROWSER: '1',
    },
  });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { serverError += chunk; });
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {}
    await delay(50);
  }
  throw new Error(`dashboard did not start: ${serverError}`);
});

afterAll(async () => {
  try { await fetch(`${BASE}/shutdown`); } catch {}
  try { server?.kill('SIGTERM'); } catch {}
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe('dashboard review precision ledger safety', () => {
  test('reads a bounded regular ledger', async () => {
    resetLedger();
    writeFileSync(LEDGER, JSON.stringify({
      schema_v: 1,
      type: 'triage_decision',
      ts: '2026-08-26T00:00:00.000Z',
      reviewed_commit: 'c1',
      finding_id: 'rf_1',
      lens: 'logic',
      severity: 'medium',
      decision: 'fix_now',
    }) + '\n');

    const { response, body } = await requestPrecision();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', totals: { decided: 1, fix_now: 1 } });
  });

  test('rejects a symlinked ledger without reading its target', async () => {
    resetLedger();
    const outside = join(SANDBOX, 'outside-ledger.jsonl');
    writeFileSync(outside, '{"schema_v":1}\n');
    symlinkSync(outside, LEDGER);

    const { response, body } = await requestPrecision();
    expect(response.status).toBe(400);
    expect(body.status).toBe('unsafe_ledger');
    expect(readFileSync(outside, 'utf8')).toBe('{"schema_v":1}\n');
  });

  test('rejects a special-file path', async () => {
    resetLedger();
    mkdirSync(LEDGER);

    const { response, body } = await requestPrecision();
    expect(response.status).toBe(400);
    expect(body.status).toBe('unsafe_ledger');
  });

  test('rejects a symlinked ledger parent without reading outside the XM root', async () => {
    restoreReviewDir();
    const outsideReview = join(SANDBOX, 'outside-review');
    mkdirSync(outsideReview, { recursive: true });
    writeFileSync(join(outsideReview, 'triage-ledger.jsonl'), '{"schema_v":1}\n');
    rmSync(REVIEW_DIR, { recursive: true, force: true });
    symlinkSync(outsideReview, REVIEW_DIR, 'dir');

    const { response, body } = await requestPrecision();
    expect(response.status).toBe(400);
    expect(body.status).toBe('unsafe_ledger');
    restoreReviewDir();
  });

  test('rejects a FIFO ledger without blocking the server', async () => {
    resetLedger();
    const fifo = spawnSync('mkfifo', [LEDGER]);
    if (fifo.status !== 0) return;

    const { response, body } = await requestPrecision();
    expect(response.status).toBe(400);
    expect(body.status).toBe('unsafe_ledger');
  });

  test('rejects a ledger above the read bound', async () => {
    resetLedger();
    writeFileSync(LEDGER, 'x'.repeat(4 * 1024 * 1024 + 1));

    const { response, body } = await requestPrecision();
    expect(response.status).toBe(413);
    expect(body.status).toBe('ledger_too_large');
  });
});
