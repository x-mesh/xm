/**
 * x-panel/tm-events — best-effort live telemetry to a term-mesh daemon
 * (XK-EVENTS-v1, docs/x-panel-term-mesh-phase2.md §4).
 *
 * The publisher mirrors the run's status.json snapshots onto the term-meshd
 * event bus (`events.publish {kind:"xk_run"}`) so in-term-mesh subscribers get
 * sub-second push updates instead of 2s file polling. status.json remains the
 * authoritative, durable record — this layer is an accelerator only:
 *
 *  - NEVER blocks or fails a run: connect timeout 50ms, writes are
 *    fire-and-forget, sustained backpressure disables publishing.
 *  - Warns ONCE on stderr when a detected socket turns out dead (L6: visible,
 *    not spammy); absence of a socket is silent (non-term-mesh shells).
 *  - Coalesces: ≤1 event per model per second, except state/phase transitions
 *    which always flush (contract rule 2).
 *  - tail ≤256 chars, taken from status model tails which the CLI has already
 *    passed through redactPanelText — no unredacted bytes reach this module.
 *
 * Zero-import leaf beyond node builtins (same rule as adapters.mjs).
 */

import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CONNECT_TIMEOUT_MS = 50;
const COALESCE_MS = 1000;
const TAIL_MAX_CHARS = 256;
// Sustained unflushed bytes ⇒ the daemon stopped reading; drop out instead of
// buffering forever (stand-in for the contract's 100ms write timeout, which
// Node's async socket API can't express per-write).
const MAX_BUFFERED_BYTES = 64 * 1024;

/**
 * Resolve the term-meshd daemon socket the same way tm-agent does
 * (detect_daemon_socket in daemon/term-mesh-cli/src/tm_agent.rs):
 * TERMMESH_DAEMON_SOCKET → TERMMESH_DAEMON_UNIX_PATH → $TMPDIR/term-meshd.sock → /tmp/term-meshd.sock.
 * Returns null when nothing exists — the caller stays silent in that case.
 */
export function detectDaemonSocket(env = process.env, tmpDirs = [env.TMPDIR, '/tmp']) {
  for (const key of ['TERMMESH_DAEMON_SOCKET', 'TERMMESH_DAEMON_UNIX_PATH']) {
    const p = env[key];
    if (p && existsSync(p)) return p;
  }
  // Fallback dirs, first hit wins. `/tmp` is checked in addition to $TMPDIR
  // because on macOS $TMPDIR is a per-user /var/folders/… path while term-mesh
  // creates its socket at /tmp/term-meshd.sock — without /tmp the zero-config
  // path silently misses a running daemon (plan §9). Duplicates are harmless.
  for (const dir of tmpDirs) {
    if (!dir) continue;
    const p = join(dir, 'term-meshd.sock');
    if (existsSync(p)) return p;
  }
  return null;
}

const INACTIVE = Object.freeze({
  active: false,
  publishStatus() {},
  close() {},
});

/**
 * Subscribe to xk_run events on the term-meshd bus (t4: the push side of
 * `xm panel status --watch`). Best-effort accelerator: callers keep their
 * poll loop as the authoritative source and treat `onDrop` as "fall back to
 * polling", never as an error.
 *
 * @param {object} opts
 * @param {(ev: object) => void} opts.onEvent  called per xk_run event (flat {kind, run, model, …})
 * @param {(reason: string) => void} [opts.onDrop]  called AT MOST ONCE when the stream dies
 * @param {string|null} [opts.socketPath]  explicit socket (tests); undefined ⇒ detect
 * @param {object} [opts.env]
 * @returns {{ active: boolean, close(): void }}
 */
export function subscribeXkRun({ onEvent, onDrop = () => {}, socketPath, env = process.env } = {}) {
  const path = socketPath !== undefined ? socketPath : detectDaemonSocket(env);
  if (!path || typeof onEvent !== 'function') return { active: false, close() {} };

  let closed = false;
  let buf = '';
  const drop = (reason) => {
    if (closed) return;
    closed = true;
    try { sock.destroy(); } catch { /* already gone */ }
    onDrop(reason);
  };

  const sock = createConnection(path);
  sock.on('error', (e) => drop(e.code || e.message || 'socket error'));
  sock.on('close', () => drop('connection closed'));
  sock.on('connect', () => {
    // kinds is an explicit opt-in — xk_run is never in the default filter set.
    sock.write(JSON.stringify({ id: 1, method: 'events.subscribe', params: { kinds: ['xk_run'] } }) + '\n');
  });
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      // Stream frames are flat {kind: "..."}; the subscribe ack ({id, result})
      // and keepalives are silently skipped.
      if (o && o.kind === 'xk_run') {
        try { onEvent(o); } catch { /* subscriber callback must never kill the stream */ }
      }
    }
  });
  // The caller's poll loop owns process lifetime; the stream must never hold
  // the CLI open on its own.
  if (sock.unref) sock.unref();

  return {
    active: true,
    close() {
      closed = true; // suppress onDrop — this is a deliberate shutdown
      try { sock.destroy(); } catch { /* best-effort */ }
    },
  };
}

/**
 * Create a publisher bound to one run.
 *
 * @param {object} opts
 * @param {string} opts.run       run id (== .xm/{panel|cross}/<run>/ dir name)
 * @param {string} opts.runKind   "review" | "cross"
 * @param {string} [opts.title]   human run title (run-level events only)
 * @param {string} [opts.source]  producer id (default "x-panel")
 * @param {boolean} [opts.enabled]  false ⇒ inert (--no-tm-events / panel.tm_events:false)
 * @param {string|null} [opts.socketPath]  explicit socket (tests); undefined ⇒ detect
 * @param {object} [opts.env]     env for detection (tests)
 * @param {() => number} [opts.now]  clock (tests)
 * @param {(msg: string) => void} [opts.warn]  warn sink (tests; default stderr)
 * @returns {{ active: boolean, publishStatus(status: object): void, close(): void }}
 */
export function createTmEventsPublisher({
  run,
  runKind,
  title = null,
  source = 'x-panel',
  enabled = true,
  socketPath,
  env = process.env,
  now = Date.now,
  warn = (msg) => process.stderr.write(`${msg}\n`),
} = {}) {
  if (!enabled || !run || !runKind) return INACTIVE;
  const path = socketPath !== undefined ? socketPath : detectDaemonSocket(env);
  if (!path) return INACTIVE; // not in term-mesh — silent no-op by contract

  let dead = false;
  let warned = false;
  let reqId = 0;
  const startedMs = now();
  // per-model last published { atMs, state }; run-level phase tracked separately
  const lastByModel = new Map();
  let lastRunPhase = null;

  const fail = (reason) => {
    if (dead) return;
    dead = true;
    if (!warned) {
      warned = true;
      warn(`[x-panel] tm-events: live publish disabled for this run (${reason}) — status.json polling unaffected`);
    }
    try { sock.destroy(); } catch { /* already gone */ }
  };

  const sock = createConnection(path);
  sock.on('error', (e) => fail(e.code || e.message || 'socket error'));
  // Route an UNEXPECTED close through fail() so it warns once (L6: a daemon that
  // dies mid-run is a dead socket). A deliberate close() sets `dead` first, so
  // fail()'s guard makes the resulting 'close' a silent no-op.
  sock.on('close', () => fail('connection closed'));
  sock.on('data', () => { /* drain responses — publish is fire-and-forget */ });
  if (sock.unref) sock.unref();
  const connectTimer = setTimeout(() => {
    if (sock.connecting) fail(`connect timeout ${CONNECT_TIMEOUT_MS}ms`);
  }, CONNECT_TIMEOUT_MS);
  if (connectTimer.unref) connectTimer.unref();
  sock.on('connect', () => clearTimeout(connectTimer));

  const send = (fields) => {
    if (dead) return;
    if (sock.writableLength > MAX_BUFFERED_BYTES) {
      fail('write backpressure');
      return;
    }
    const params = { kind: 'xk_run', v: 1, source, run, run_kind: runKind, ...fields };
    try {
      sock.write(JSON.stringify({ id: ++reqId, method: 'events.publish', params }) + '\n');
    } catch (e) {
      fail(e.message || 'write failed');
    }
  };

  const clipTail = (m) => {
    const t = m.stdout_tail || m.stderr_tail || '';
    if (!t) return undefined;
    return t.length > TAIL_MAX_CHARS ? t.slice(-TAIL_MAX_CHARS) : t;
  };

  return {
    active: true,

    /**
     * Diff a status.json snapshot against the last published state and emit
     * the delta. Call at every status flush — coalescing lives here, so the
     * caller never throttles.
     */
    publishStatus(status) {
      if (dead || !status) return;
      const t = now();
      const phase = status.phase || 'running';
      if (phase !== lastRunPhase) {
        lastRunPhase = phase;
        send({
          phase,
          model: '',
          state: phase === 'done' ? 'ok' : 'running',
          elapsed_ms: t - startedMs,
          ...(title ? { title } : {}),
        });
      }
      for (const m of status.models || []) {
        // done/failed ⇒ terminal; timeout surfaces as failed with the error text
        const state = m.state === 'done' ? 'ok' : m.state;
        if (state === 'pending') continue;
        const last = lastByModel.get(m.label);
        const isTransition = !last || last.state !== state;
        if (!isTransition && !(state === 'running' && t - last.atMs >= COALESCE_MS)) continue;
        const tail = clipTail(m);
        send({
          phase,
          model: m.label,
          // first sighting of a running model = the spawn transition
          state: state === 'running' && !last ? 'spawned' : state,
          elapsed_ms: Math.round((m.elapsed_s || 0) * 1000),
          ...(tail ? { tail } : {}),
        });
        lastByModel.set(m.label, { atMs: t, state });
      }
    },

    close() {
      clearTimeout(connectTimer);
      if (!dead) {
        try { sock.end(); } catch { /* best-effort */ }
      }
      dead = true;
    },
  };
}
