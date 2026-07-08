/**
 * x-panel tm-events publisher (t2, docs/x-panel-term-mesh-phase2.md).
 * Verifies XK-EVENTS-v1 client rules against a fake term-meshd UNIX socket:
 * silent no-op without a socket, event shape, transition-vs-coalesce, tail
 * clipping, and warn-once on a dead socket (R1/R2).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTmEventsPublisher,
  detectDaemonSocket,
  subscribeXkRun,
} from '../x-panel/lib/x-panel/tm-events.mjs';

const CLI = join(import.meta.dirname, '..', 'x-panel', 'lib', 'x-panel-cli.mjs');
const STUB = join(import.meta.dirname, 'fixtures', 'panel-stub-model.mjs');

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

function fakeDaemon() {
  const dir = mkdtempSync(join(tmpdir(), 'tm-events-'));
  const path = join(dir, 'term-meshd.sock');
  const lines = [];
  const server = createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) lines.push(JSON.parse(line));
        conn.write(JSON.stringify({ id: null, result: { published: true }, error: null }) + '\n');
      }
    });
  });
  server.listen(path);
  cleanups.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { path, lines };
}

const drain = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function statusWith(phase, models) {
  return { phase, models };
}
const model = (label, state, extra = {}) => ({
  label, state, elapsed_s: 1, stdout_tail: '', stderr_tail: '', ...extra,
});

describe('detectDaemonSocket', () => {
  test('env override wins, default path checked last, null when absent', () => {
    const { path } = fakeDaemon();
    expect(detectDaemonSocket({ TERMMESH_DAEMON_SOCKET: path })).toBe(path);
    expect(detectDaemonSocket({ TERMMESH_DAEMON_UNIX_PATH: path })).toBe(path);
    // TMPDIR fallback: point TMPDIR at the fake socket's dir.
    expect(detectDaemonSocket({ TMPDIR: join(path, '..') })).toBe(path);
    expect(detectDaemonSocket({ TMPDIR: '/nonexistent-tmpdir-xyz' })).toBeNull();
  });
});

// Fake daemon that speaks the events.subscribe side of the protocol: acks the
// subscription, then lets the test push raw event frames to every subscriber.
function fakeDaemonBus() {
  const dir = mkdtempSync(join(tmpdir(), 'tm-events-bus-'));
  const path = join(dir, 'term-meshd.sock');
  const conns = [];
  const server = createServer((conn) => {
    conns.push(conn);
    conn.on('data', () => {
      conn.write(JSON.stringify({ id: 1, result: { status: 'subscribed', filter: ['xk_run'] }, error: null }) + '\n');
    });
    conn.on('error', () => { /* test teardown */ });
  });
  server.listen(path);
  cleanups.push(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    path,
    emit(frame) { for (const c of conns) c.write(JSON.stringify(frame) + '\n'); },
    killAll() { for (const c of conns) c.destroy(); },
  };
}

describe('subscribeXkRun', () => {
  test('inactive without a socket', () => {
    const sub = subscribeXkRun({ socketPath: null, onEvent: () => {} });
    expect(sub.active).toBe(false);
    sub.close();
  });

  test('delivers xk_run frames, skips acks and keepalives', async () => {
    const bus = fakeDaemonBus();
    const got = [];
    const sub = subscribeXkRun({ socketPath: bus.path, onEvent: (ev) => got.push(ev) });
    expect(sub.active).toBe(true);
    await drain();
    bus.emit({ kind: 'keepalive', ts_ms: 1 });
    bus.emit({ kind: 'xk_run', v: 1, run: 'r1', model: 'claude', state: 'running', ts_ms: 2 });
    bus.emit({ kind: 'task_status', team: 't', ts_ms: 3 }); // never delivered for this filter, but tolerate
    await drain();
    sub.close();
    expect(got.length).toBe(1);
    expect(got[0].run).toBe('r1');
    expect(got[0].model).toBe('claude');
  });

  test('onDrop fires exactly once when the daemon dies; not on deliberate close', async () => {
    const bus = fakeDaemonBus();
    const drops = [];
    const sub = subscribeXkRun({ socketPath: bus.path, onEvent: () => {}, onDrop: (r) => drops.push(r) });
    await drain();
    bus.killAll();
    await drain();
    expect(drops.length).toBe(1);

    const bus2 = fakeDaemonBus();
    const drops2 = [];
    const sub2 = subscribeXkRun({ socketPath: bus2.path, onEvent: () => {}, onDrop: (r) => drops2.push(r) });
    await drain();
    sub2.close(); // deliberate — must NOT count as a drop
    await drain();
    expect(drops2.length).toBe(0);
    sub.close();
  });
});

describe('createTmEventsPublisher', () => {
  test('inactive (silent no-op) when no socket or disabled', () => {
    const warns = [];
    const off = createTmEventsPublisher({
      run: 'r1', runKind: 'review', socketPath: null, warn: (m) => warns.push(m),
    });
    expect(off.active).toBe(false);
    off.publishStatus(statusWith('running', [model('claude', 'running')]));
    off.close();
    const disabled = createTmEventsPublisher({
      run: 'r1', runKind: 'review', enabled: false, warn: (m) => warns.push(m),
    });
    expect(disabled.active).toBe(false);
    expect(warns).toEqual([]); // absence of a socket is never a warning
  });

  test('publishes phase + model transitions with the XK-EVENTS-v1 shape', async () => {
    const { path, lines } = fakeDaemon();
    const pub = createTmEventsPublisher({
      run: '20260707-x', runKind: 'review', title: 'diff HEAD~1',
      socketPath: path, now: () => 1000,
    });
    expect(pub.active).toBe(true);
    pub.publishStatus(statusWith('round1 (review)', [model('claude', 'running')]));
    await drain();
    pub.close();

    expect(lines.length).toBe(2);
    for (const l of lines) {
      expect(l.method).toBe('events.publish');
      expect(l.params.kind).toBe('xk_run');
      expect(l.params.v).toBe(1);
      expect(l.params.source).toBe('x-panel');
      expect(l.params.run).toBe('20260707-x');
      expect(l.params.run_kind).toBe('review');
    }
    const [phaseEv, modelEv] = lines.map((l) => l.params);
    expect(phaseEv.model).toBe('');
    expect(phaseEv.phase).toBe('round1 (review)');
    expect(phaseEv.title).toBe('diff HEAD~1');
    expect(modelEv.model).toBe('claude');
    expect(modelEv.state).toBe('spawned'); // first sighting = spawn transition
  });

  test('coalesces running ticks to 1/s but always sends transitions', async () => {
    const { path, lines } = fakeDaemon();
    let t = 0;
    const pub = createTmEventsPublisher({
      run: 'r', runKind: 'cross', socketPath: path, now: () => t,
    });
    const running = statusWith('running', [model('claude', 'running')]);
    t = 0; pub.publishStatus(running);          // phase + spawned
    t = 100; pub.publishStatus(running);        // coalesced away (<1s)
    t = 500; pub.publishStatus(running);        // coalesced away
    t = 1200; pub.publishStatus(running);       // 1s elapsed → progress tick
    t = 1300; pub.publishStatus(statusWith('running', [model('claude', 'done')])); // transition → always
    await drain();
    pub.close();

    const states = lines.map((l) => l.params.state);
    expect(states).toEqual(['running', 'spawned', 'running', 'ok']);
  });

  test('clips tail to 256 chars and omits empty tails', async () => {
    const { path, lines } = fakeDaemon();
    const pub = createTmEventsPublisher({ run: 'r', runKind: 'review', socketPath: path });
    pub.publishStatus(statusWith('running', [
      model('claude', 'running', { stdout_tail: 'x'.repeat(300) }),
    ]));
    await drain();
    pub.close();
    const modelEv = lines.map((l) => l.params).find((p) => p.model === 'claude');
    expect(modelEv.tail.length).toBe(256);
    const phaseEv = lines.map((l) => l.params).find((p) => p.model === '');
    expect(phaseEv.tail).toBeUndefined();
  });

  test('e2e: a stubbed review run publishes phases + per-model lifecycle (R1)', async () => {
    const { path, lines } = fakeDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'tm-events-e2e-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = spawnSync('node', [CLI, 'review', 'some diff', '--models', 'claude,codex'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        X_PANEL_ROOT: join(dir, '.xm'),
        X_PANEL_GLOBAL_ROOT: join(dir, '.xm-g'),
        X_PANEL_CMD_CLAUDE: STUB,
        X_PANEL_CMD_CODEX: STUB,
        NO_COLOR: '1',
        TERMMESH_DAEMON_SOCKET: path,
      },
    });
    expect(r.status).toBe(0);
    await drain(200);
    const evs = lines.map((l) => l.params);
    expect(evs.length).toBeGreaterThanOrEqual(3); // R1: starting/rounds + models + done
    expect(evs.every((p) => p.kind === 'xk_run' && p.v === 1 && p.run)).toBe(true);
    const phases = evs.filter((p) => p.model === '').map((p) => p.phase);
    expect(phases[0]).toBe('starting');
    expect(phases).toContain('round1 (review)');
    expect(phases[phases.length - 1]).toBe('done');
    const claude = evs.filter((p) => p.model === 'claude').map((p) => p.state);
    expect(claude[0]).toBe('spawned');
    expect(claude).toContain('ok');
  });

  test('e2e: a dead socket never breaks the run and warns once (R2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm-events-e2e-dead-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = spawnSync('node', [CLI, 'review', 'some diff', '--models', 'claude,codex'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        X_PANEL_ROOT: join(dir, '.xm'),
        X_PANEL_GLOBAL_ROOT: join(dir, '.xm-g'),
        X_PANEL_CMD_CLAUDE: STUB,
        X_PANEL_CMD_CODEX: STUB,
        NO_COLOR: '1',
        // exists (it's a dir, not a socket) → detection passes, connect fails
        TERMMESH_DAEMON_SOCKET: dir,
      },
    });
    expect(r.status).toBe(0); // run unaffected
    expect(r.stdout).toContain('Panel verdict');
    const warnings = r.stderr.split('\n').filter((l) => l.includes('tm-events: live publish disabled'));
    expect(warnings.length).toBe(1);
  });

  test('e2e: --no-tm-events publishes nothing', async () => {
    const { path, lines } = fakeDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'tm-events-e2e-off-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = spawnSync('node', [CLI, 'review', 'some diff', '--models', 'claude,codex', '--no-tm-events'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        X_PANEL_ROOT: join(dir, '.xm'),
        X_PANEL_GLOBAL_ROOT: join(dir, '.xm-g'),
        X_PANEL_CMD_CLAUDE: STUB,
        X_PANEL_CMD_CODEX: STUB,
        NO_COLOR: '1',
        TERMMESH_DAEMON_SOCKET: path,
      },
    });
    expect(r.status).toBe(0);
    await drain(200);
    expect(lines.length).toBe(0);
  });

  test('warns exactly once and goes inert when the socket is dead', async () => {
    const warns = [];
    const pub = createTmEventsPublisher({
      run: 'r', runKind: 'review',
      socketPath: join(tmpdir(), 'definitely-missing.sock'),
      warn: (m) => warns.push(m),
    });
    expect(pub.active).toBe(true); // dead socket is only discovered on connect
    pub.publishStatus(statusWith('running', [model('claude', 'running')]));
    await drain();
    pub.publishStatus(statusWith('running', [model('claude', 'done')]));
    pub.publishStatus(statusWith('done', [model('claude', 'done')]));
    await drain();
    pub.close();
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('status.json polling unaffected');
  });
});
