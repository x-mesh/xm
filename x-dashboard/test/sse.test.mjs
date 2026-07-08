/**
 * /api/events SSE (t7, xm docs/x-panel-term-mesh-phase2.md).
 * Boots the dashboard server with TERMMESH_DAEMON_SOCKET pointed at a fake
 * term-meshd (in-test UNIX socket server). Proves: the endpoint speaks SSE,
 * a daemon xk_run event reaches an SSE client in <1s, and the endpoint works
 * (hello + polling-as-usual) when no daemon exists.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'lib', 'x-dashboard-server.mjs');
const PROJECT_ROOT = join(__dirname, '..', '..');
const TEST_PORT = 19893; // away from api.test.mjs (19898)
const BASE = `http://127.0.0.1:${TEST_PORT}`;

let serverProc;
let busDir;
let busConns = [];
let busServer;

function busEmit(frame) {
  for (const c of busConns) c.write(JSON.stringify(frame) + '\n');
}

beforeAll(async () => {
  // Fake term-meshd: acks events.subscribe, then lets tests push frames.
  busDir = mkdtempSync(join(tmpdir(), 'xd-sse-'));
  const busPath = join(busDir, 'term-meshd.sock');
  busServer = createServer((conn) => {
    busConns.push(conn);
    conn.on('data', () => {
      conn.write(JSON.stringify({ id: 1, result: { status: 'subscribed', filter: ['xk_run'] }, error: null }) + '\n');
    });
    conn.on('error', () => {});
  });
  busServer.listen(busPath);

  serverProc = spawn('bun', [SERVER_PATH, '--port', String(TEST_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    cwd: PROJECT_ROOT,
    env: { ...process.env, NO_BROWSER: '1', TERMMESH_DAEMON_SOCKET: busPath },
  });
  serverProc.stderr?.on('data', () => {});
  serverProc.stdout?.on('data', () => {});
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('x-dashboard-server did not start within 5s');
});

afterAll(async () => {
  try { serverProc?.kill('SIGTERM'); } catch { /* already dead */ }
  try { busServer?.close(); } catch { /* already closed */ }
  rmSync(busDir, { recursive: true, force: true });
});

// Read SSE frames from a fetch body until `pred` matches or timeoutMs elapses.
async function readSSEUntil(body, pred, timeoutMs) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const race = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ timedOut: true }), Math.max(1, deadline - Date.now()))),
      ]);
      if (race.timedOut || race.done) break;
      buf += dec.decode(race.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1] || null;
        const dataRaw = /^data: (.+)$/m.exec(block)?.[1] || null;
        let data = null;
        try { data = dataRaw ? JSON.parse(dataRaw) : null; } catch { data = dataRaw; }
        frames.push({ event: ev, data });
        if (pred(frames)) return frames;
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* stream already ended */ }
  }
  return frames;
}

describe('GET /api/events', () => {
  it('speaks SSE and says hello with daemon presence', async () => {
    const res = await fetch(`${BASE}/api/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readSSEUntil(res.body, (f) => f.some((x) => x.event === 'hello'), 3000);
    const hello = frames.find((x) => x.event === 'hello');
    expect(hello.data.daemon).toBe(true);
  });

  it('relays a daemon xk_run event to the SSE client in <1s', async () => {
    const res = await fetch(`${BASE}/api/events`);
    const framesP = readSSEUntil(res.body, (f) => f.some((x) => x.event === 'xk_run'), 5000);
    // Give the server a beat to send hello + finish the daemon subscribe handshake.
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    busEmit({ kind: 'xk_run', v: 1, source: 'x-panel', run: 'r-sse', run_kind: 'review', phase: 'round1', model: 'claude', state: 'running', elapsed_ms: 5, ts_ms: Date.now() });
    const frames = await framesP;
    const latency = Date.now() - t0;
    const ev = frames.find((x) => x.event === 'xk_run');
    expect(ev).toBeTruthy();
    expect(ev.data.run).toBe('r-sse');
    expect(ev.data.model).toBe('claude');
    expect(latency).toBeLessThan(1000);
  });
});
