// @ts-check
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireProcessLock, releaseProcessLock } from '../xm/lib/install/propagate-lock.mjs';

/** @type {string[]} */
const tmpdirs = [];

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'xm-propagate-lock-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  // Cleanup: release any leftover locks (best-effort).
  for (const dir of tmpdirs) {
    const lockPath = join(dir, 'test.lock');
    try { releaseProcessLock(lockPath); } catch { /* ignore */ }
  }
  tmpdirs.length = 0;
});

describe('propagate-lock', () => {
  test('acquire/release roundtrip', () => {
    const tmp = makeTmp();
    const lockPath = join(tmp, 'test.lock');

    const handle = acquireProcessLock(lockPath);
    expect(handle.released).toBe(true);
    expect(existsSync(lockPath)).toBe(true);

    const payload = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(typeof payload.pid).toBe('number');
    expect(typeof payload.timestamp).toBe('number');
    expect(Array.isArray(payload.argv)).toBe(true);

    handle.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('concurrent acquire fails', () => {
    const tmp = makeTmp();
    const lockPath = join(tmp, 'test.lock');

    const handle = acquireProcessLock(lockPath);
    expect(handle.released).toBe(true);

    expect(() => acquireProcessLock(lockPath)).toThrow(/lock held/);

    handle.release();
  });

  test('stale lock takeover (expired ttl)', () => {
    const tmp = makeTmp();
    const lockPath = join(tmp, 'test.lock');

    // Write a stale lock manually (timestamp far in the past).
    const stalePayload = {
      pid: process.pid,
      timestamp: Date.now() - 400_000, // older than default 300s TTL
      argv: [],
    };
    writeFileSync(lockPath, JSON.stringify(stalePayload));

    // Should succeed (takeover stale lock).
    const handle = acquireProcessLock(lockPath);
    expect(handle.released).toBe(true);

    const payload = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(payload.pid).toBe(process.pid);

    handle.release();
  });

  test('stale lock takeover (dead pid)', () => {
    const tmp = makeTmp();
    const lockPath = join(tmp, 'test.lock');

    // PID 999999 almost certainly does not exist.
    const deadPidPayload = {
      pid: 999999,
      timestamp: Date.now(), // fresh timestamp, but PID is dead
      argv: [],
    };
    writeFileSync(lockPath, JSON.stringify(deadPidPayload));

    // Should succeed because PID is not alive.
    const handle = acquireProcessLock(lockPath);
    expect(handle.released).toBe(true);

    const payload = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(payload.pid).toBe(process.pid);

    handle.release();
  });

  test('payload contains pid and argv', () => {
    const tmp = makeTmp();
    const lockPath = join(tmp, 'test.lock');

    const handle = acquireProcessLock(lockPath, { argv: ['--propagate'] });
    expect(handle.released).toBe(true);

    const payload = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(payload.pid).toBe(process.pid);
    expect(payload.argv).toEqual(['--propagate']);

    handle.release();
  });
});
