#!/usr/bin/env node
// x-remote peer relay — control a term-mesh peer surface remotely.
//
// Snapshot-driven (NOT continuous streaming): actions run via
// `tm-agent peer send-key`; reads are a vt100-rendered `peer snapshot`. No
// screen-scraping, no flood. UI-agnostic core: the x-remote gateway drives it
// from both text `!xr` commands AND the interactive Discord panel.
//
// Commands act on a *current surface* (defaults to the only exposed one);
// `surfaces()`/`setSurface()` switch it, so callers rarely pass a name.
//
// Env: TM_AGENT / XR_PEER_SOCKET / XR_PEER_HOST / XR_PEER_SURFACE / XR_SETTLE_MS

import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createPeerRelay({
  tmAgent = process.env.TM_AGENT || 'tm-agent',
  host = process.env.XR_PEER_HOST || '',
  socket = process.env.XR_PEER_SOCKET || '/run/user/0/tm-peer.sock',
  defaultSurface = process.env.XR_PEER_SURFACE || 'shell',
  settleMs = Number(process.env.XR_SETTLE_MS || 1200),
} = {}) {
  // snapshot/send-key take --socket|--host; `list` takes a positional socket
  // (or --host). attach is never used (snapshot-driven).
  const targetArgs = () => (host ? ['--host', host] : ['--socket', socket]);
  const listArgs = () => (host ? ['--host', host] : [socket]);
  let current = defaultSurface;

  function runTmAgent(args) {
    return new Promise((resolve) => {
      const child = spawn(tmAgent, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }));
      child.on('close', (code) => resolve({ code, out, err }));
    });
  }

  function fmtSnap(snap) {
    if (snap.code !== 0) return `snapshot failed: ${(snap.err || '').trim() || snap.code}`;
    // vt100 grid still carries the layout's blank rows (full-screen TUIs pad the
    // height); trim trailing spaces and collapse blank runs for a tight post.
    const body = (snap.out || '(empty)')
      .replace(/`/g, "'")
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{2,}/g, '\n')
      .trim()
      .slice(-1800);
    return '```\n[' + current + ']\n' + body + '\n```';
  }

  async function snapshot() {
    return fmtSnap(await runTmAgent(['peer', 'snapshot', ...targetArgs(), '--name', current]));
  }
  // raw writers — send only, no snapshot (the panel refreshes once afterward).
  async function sendKeys(keyStr) {
    const keys = String(keyStr).split(/\s+/).filter(Boolean);
    const r = await runTmAgent(['peer', 'send-key', ...targetArgs(), '--name', current, ...keys]);
    await sleep(settleMs);
    return r;
  }
  async function sendText(text) {
    const r = await runTmAgent(['peer', 'send-key', ...targetArgs(), '--name', current, String(text), 'Enter']);
    await sleep(settleMs);
    return r;
  }
  async function surfaces() {
    const r = await runTmAgent(['peer', 'list', ...listArgs()]);
    if (r.code !== 0) return [];
    const seen = new Set();
    const out = [];
    for (const raw of (r.out || '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      // Titles may contain spaces ("shell 4"); take everything up to the first
      // run of 2+ spaces (column padding) as the name, and dedupe by name so a
      // select menu never gets duplicate option values (Discord rejects those).
      const m = line.match(/^(\S.*?)\s{2,}/);
      const name = (m ? m[1] : line.split(/\s+/)[0]).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, line });
    }
    return out;
  }
  async function peers() {
    const list = await surfaces();
    if (!list.length) return '(no surfaces exposed)';
    const body = list.map((s) => (s.name === current ? '→ ' : '  ') + s.line).join('\n');
    return '```\nsurfaces (→ current):\n' + body + '\n```\nswitch with `!xr use <name>`';
  }

  const need = (usage) =>
    `current surface: \`${current}\`. usage: \`!xr ${usage}\` · list: \`!xr peers\``;

  return {
    get current() {
      return current;
    },
    setSurface(s) {
      current = s;
      return current;
    },
    snapshot,
    sendKeys,
    sendText,
    surfaces,
    peers,
    // text-command conveniences (act + show):
    type: async (text) => (text ? ((await sendText(text)), snapshot()) : need('type <text>')),
    keys: async (keyStr) => (keyStr ? ((await sendKeys(keyStr)), snapshot()) : need('key <keys>')),
    interrupt: async () => ((await sendKeys('C-c')), snapshot()),
  };
}

// ── standalone DRY harness (run this file directly) ────────────────
if (import.meta.main) {
  const { createInterface } = await import('node:readline');
  const relay = createPeerRelay();
  console.log(`[dry] current surface=${relay.current}`);
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const input = line.trim();
    if (!input) continue;
    const [verb, ...rest] = input.split(/\s+/);
    const text = rest.join(' ');
    let res;
    if (verb === 'peers') res = await relay.peers();
    else if (verb === 'use') res = 'current: ' + relay.setSurface(rest[0]);
    else if (verb === 'snap') res = await relay.snapshot();
    else if (verb === 'type') res = await relay.type(text);
    else if (verb === 'key') res = await relay.keys(text);
    else res = '(peers | use <s> | snap | type <text> | key <keys>)';
    console.log('--- ' + input + '\n' + res);
  }
}
