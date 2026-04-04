/**
 * x-dashboard-server lifecycle tests
 *
 * Tests: PID file creation, health endpoint, SIGTERM shutdown, --stop flag
 * Approach: subprocess — each test spawns the server as a child process
 */

import { test, expect, afterEach, describe } from 'bun:test';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, '..', 'lib', 'x-dashboard-server.mjs');
const PID_FILE = join(homedir(), '.xm', 'run', 'xdashboard-server.pid');

const TEST_PORT_1 = 19898;
const TEST_PORT_2 = 19897;

/** Wait for condition to be true, polling every 100ms up to timeoutMs */
async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await Bun.sleep(100);
  }
  return false;
}

/** Start server on given port, return proc handle */
function startServer(port) {
  return Bun.spawn(['bun', SERVER_PATH, '--port', String(port)], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_BROWSER: '1' },
  });
}

/** Clean up: kill process if still alive, remove PID file */
async function cleanup(proc) {
  if (proc) {
    try { proc.kill('SIGKILL'); } catch {}
    try { await proc.exited; } catch {}
  }
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
}

describe('x-dashboard-server lifecycle', () => {
  let currentProc = null;

  afterEach(async () => {
    await cleanup(currentProc);
    currentProc = null;
  });

  test('start creates PID file with valid pid/port', async () => {
    currentProc = startServer(TEST_PORT_1);

    // Wait for PID file to appear
    const appeared = await waitFor(() => existsSync(PID_FILE), 8000);
    expect(appeared).toBe(true);

    // Parse and validate contents
    const raw = readFileSync(PID_FILE, 'utf8');
    const data = JSON.parse(raw);

    expect(typeof data.pid).toBe('number');
    expect(data.pid).toBeGreaterThan(0);
    expect(data.port).toBe(TEST_PORT_1);
  }, 10000);

  test('health endpoint returns 200 after start', async () => {
    currentProc = startServer(TEST_PORT_1);

    // Wait until /health responds
    const healthy = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT_1}/health`);
        return res.status === 200;
      } catch {
        return false;
      }
    }, 8000);

    expect(healthy).toBe(true);

    const res = await fetch(`http://127.0.0.1:${TEST_PORT_1}/health`);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.port).toBe(TEST_PORT_1);
  }, 10000);

  test('SIGTERM causes clean shutdown and PID file removal', async () => {
    currentProc = startServer(TEST_PORT_1);

    // Wait until server is up
    const started = await waitFor(() => existsSync(PID_FILE), 8000);
    expect(started).toBe(true);

    // Send SIGTERM
    currentProc.kill('SIGTERM');

    // Wait for process to exit
    const exitCode = await Promise.race([
      currentProc.exited,
      Bun.sleep(8000).then(() => null),
    ]);

    expect(exitCode).toBe(0);

    // PID file should be removed
    expect(existsSync(PID_FILE)).toBe(false);
  }, 12000);

  test('--stop flag stops the server and removes PID file', async () => {
    // Start server on port 2
    currentProc = startServer(TEST_PORT_2);

    // Wait until healthy
    const healthy = await waitFor(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${TEST_PORT_2}/health`);
        return res.status === 200;
      } catch {
        return false;
      }
    }, 8000);
    expect(healthy).toBe(true);

    // Run --stop
    const stopProc = Bun.spawn(
      ['bun', SERVER_PATH, '--port', String(TEST_PORT_2), '--stop'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    const stopCode = await Promise.race([
      stopProc.exited,
      Bun.sleep(8000).then(() => 'timeout'),
    ]);
    expect(stopCode).toBe(0);

    // Server process should have exited
    const serverExited = await Promise.race([
      currentProc.exited.then(() => true),
      Bun.sleep(3000).then(() => false),
    ]);
    expect(serverExited).toBe(true);

    // PID file should be removed
    expect(existsSync(PID_FILE)).toBe(false);

    // Mark proc cleaned so afterEach doesn't double-kill
    currentProc = null;
  }, 15000);
});
